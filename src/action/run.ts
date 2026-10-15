import { CONFIG_FILE, defaultConfig, loadConfig, parseConfigText, type OpendrsConfig } from "../domain/config.js";
import type { Decision, ModelWeights, Tier } from "../domain/types.js";
import { OpendrsError } from "../domain/types.js";
import { scoreDiff } from "../engine.js";
import { git, gitMaybe } from "../git/exec.js";
import { matchAny } from "../git/glob.js";
import { buildHistoryIndex } from "../git/history.js";
import { suggestReviewers } from "../policy/reviewers.js";
import { cell, renderMarkdown } from "../report/markdown.js";
import { ownApprovals, reconcileApproval, stopMerge, withdraw } from "./approval.js";
import { isSelf, sameLogin, unlessForbidden, type GitHubClient } from "./github.js";
import type { WorkflowIO } from "./workflow.js";

export { APPROVAL_MARKER } from "./approval.js";
export const COMMENT_MARKER = "<!-- opendrs -->";
const RISK_LABELS = ["risk:green", "risk:yellow", "risk:red"];

export interface ActionInputs {
  token: string;
  /** Read .opendrs.yml (and the model) from the PR's base commit. */
  baseConfig: boolean;
  llmApiKey?: string;
  comment: boolean;
  labels: boolean;
  /** Mixed into the drift-sampling key; a secret makes the sample unpredictable. */
  sampleSalt?: string;
}

/** The fields of the `pull_request` webhook payload the action uses. */
export interface PullRequest {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  /** The account that opened the PR. */
  user?: { login: string } | null;
  base: { sha: string; ref: string; repo: { full_name: string } };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
}

export interface ActionDeps {
  repoDir: string;
  event: unknown;
  inputs: ActionInputs;
  client: GitHubClient;
  io: WorkflowIO;
  /** Process environment; the LLM key is exported into it. */
  env: NodeJS.ProcessEnv;
}

export interface ActionOutcome {
  score: number;
  tier: Tier;
  decision: Decision;
  approved: boolean;
}

function readPullRequest(event: unknown): PullRequest {
  const pr = (event as { pull_request?: PullRequest } | null)?.pull_request;
  if (!pr || typeof pr.number !== "number" || !pr.base?.sha || !pr.head?.sha) {
    throw new OpendrsError("opendrs needs a pull_request event: this event has no pull_request payload", "usage");
  }
  return pr;
}

async function requireCommit(repoDir: string, sha: string, which: string): Promise<void> {
  if ((await gitMaybe(repoDir, ["cat-file", "-e", `${sha}^{commit}`])) === undefined) {
    throw new OpendrsError(`${which} commit ${sha} is not in the checkout. Use actions/checkout with fetch-depth: 0.`, "git");
  }
}

async function loadSettings(d: ActionDeps, base: string): Promise<{ config: OpendrsConfig; model?: ModelWeights }> {
  const text = await gitMaybe(d.repoDir, ["show", `${base}:${CONFIG_FILE}`]);
  const baseConfig = text === undefined ? defaultConfig() : parseConfigText(text);
  if (!d.inputs.baseConfig) {
    d.io.warning(
      `base-config is false: ${CONFIG_FILE} is read from the PR checkout, so a PR can change its own gate. ` +
        "Auto-approval still refuses PRs that modify it. The llm section and the model path still come from the base commit.",
    );
    // Never let a PR choose where the LLM key is sent (llm.baseUrl) or which secret is exported (llm.apiKeyEnv).
    return { config: { ...(await loadConfig(d.repoDir)), llm: baseConfig.llm, model: baseConfig.model } };
  }
  d.io.info(text === undefined ? `No ${CONFIG_FILE} on base commit ${base}: using defaults.` : `Using ${CONFIG_FILE} from base commit ${base}.`);
  const config = baseConfig;

  const raw = await gitMaybe(d.repoDir, ["show", `${base}:${config.model}`]);
  if (raw === undefined) return { config };
  try {
    const model = JSON.parse(raw) as ModelWeights;
    if (model.version === 1 && typeof model.intercept === "number") {
      d.io.info(`Using calibrated model ${config.model} from the base commit.`);
      return { config, model };
    }
  } catch {
    // fall through to the warning
  }
  d.io.warning(`${config.model} on the base commit is not a valid model; it is ignored.`);
  return { config };
}

const llmKeyEnv = (config: OpendrsConfig) =>
  config.llm.apiKeyEnv ?? (config.llm.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");

/**
 * Whether GitHub maps the head commit's author email to the account that opened the PR (the
 * email is otherwise whatever the PR author typed), and that account's verified emails in this PR.
 */
async function prAuthor(d: ActionDeps, pr: PullRequest): Promise<{ verified: boolean; emails: Set<string> }> {
  const commits =
    (await unlessForbidden(
      () => d.client.listPullCommits(pr.number),
      () => d.io.warning("Could not list the PR's commits (403): give the job `pull-requests: read`. The author's expertise counts as unknown."),
    )) ?? [];
  const login = pr.user?.login;
  const theirs = commits.filter((c) => sameLogin(c.author?.login, login));
  const head = commits.at(-1);
  const verified = head !== undefined && head.sha === pr.head.sha && theirs.includes(head);
  if (!verified) d.io.info(`The head commit's author is not verified as the PR's author${login ? ` @${login}` : ""}: expertise signals count as unknown.`);
  const emails = theirs.flatMap((c) => (c.commit.author?.email ? [c.commit.author.email.toLowerCase()] : []));
  return { verified, emails: new Set(emails) };
}

/** Every path the PR changes, from the merge-base; renames count as delete + add. */
async function changedFiles(repoDir: string, base: string, head: string): Promise<string[]> {
  const out = await git(repoDir, ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`]);
  return out.split("\0").filter(Boolean);
}

export async function runAction(d: ActionDeps): Promise<ActionOutcome> {
  const pr = readPullRequest(d.event);
  try {
    return await scorePullRequest(d, pr);
  } catch (e) {
    await failClosed(d, pr);
    throw e;
  }
}

/**
 * After an error, an earlier approval and auto-merge must not stay in place unchecked: dismiss our
 * approvals and stop merging. When our approvals cannot even be listed, stop merging regardless.
 */
async function failClosed({ client, io }: ActionDeps, pr: PullRequest): Promise<void> {
  io.warning("opendrs failed, so it withdraws its approval and auto-merge on this PR, if any.");
  try {
    const own = await ownApprovals(client, pr.number, await client.viewerLogin());
    await withdraw(client, io, pr, own, "opendrs could not score the latest commit");
  } catch (e) {
    io.warning(`Could not check opendrs's approvals (${e instanceof Error ? e.message : String(e)}); stopping auto-merge anyway.`);
    await stopMerge(client, io, pr);
  }
}

async function scorePullRequest(d: ActionDeps, pr: PullRequest): Promise<ActionOutcome> {
  const { client, io } = d;
  await requireCommit(d.repoDir, pr.base.sha, "Base");
  await requireCommit(d.repoDir, pr.head.sha, "Head");

  const { config, model } = await io.group("Configuration", () => loadSettings(d, pr.base.sha));
  if (d.inputs.llmApiKey) d.env[llmKeyEnv(config)] = d.inputs.llmApiKey;

  const successfulChecks =
    (await unlessForbidden(
      () => client.successfulCheckNames(pr.head.sha, d.env.GITHUB_RUN_ID),
      () => io.warning("Could not read check runs (403): give the job `checks: read`. Required AI-review checks count as missing."),
    )) ?? [];

  const author = await prAuthor(d, pr);
  const mergeBase = (await git(d.repoDir, ["merge-base", pr.base.sha, pr.head.sha])).trim();
  const history = await buildHistoryIndex(d.repoDir, mergeBase, config);

  const result = await io.group("Score", async () => {
    const r = await scoreDiff({
      repoDir: d.repoDir,
      base: pr.base.sha,
      head: pr.head.sha,
      config,
      model,
      history,
      authorVerified: author.verified,
      title: pr.title,
      description: pr.body ?? undefined,
      // Keyed by PR, not head sha, so pushing another commit cannot re-roll the drift sample.
      pr: { successfulChecks, number: pr.number, samplingKey: `${pr.base.repo.full_name}#${pr.number}#${d.inputs.sampleSalt ?? ""}` },
    });
    io.info(`score ${r.score.toFixed(3)}, tier ${r.tier}, decision ${r.policy.decision}`);
    for (const reason of r.policy.reasons) io.info(`  - ${reason}`);
    return r;
  });
  io.setOutput("score", result.score.toFixed(4));
  io.setOutput("tier", result.tier);
  io.setOutput("decision", result.policy.decision);

  const files = await changedFiles(d.repoDir, pr.base.sha, pr.head.sha);
  // Exclude the PR author's verified emails, not the head commit's claimed one, which they control.
  const paths = files.filter((f) => !matchAny(config.paths.ignore, f));
  result.policy.suggestedReviewers = suggestReviewers(history, paths, undefined, 3 + author.emails.size)
    .filter((email) => !author.emails.has(email))
    .slice(0, 3);

  const viewer = await client.viewerLogin();
  if (viewer === undefined) io.info("Could not read the token's login: opendrs's own comment and approvals are matched by marker and bot account.");
  const approval = await io.group("Approval", () => reconcileApproval({ client, io, pr, config, result, files, viewer }));

  const report = renderMarkdown(result);
  const body = `${report.startsWith(COMMENT_MARKER) ? report : `${COMMENT_MARKER}\n${report}`}\n\n**Auto-approval:** ${cell(approval.status)}`;

  if (d.inputs.comment) {
    await unlessForbidden(
      async () => {
        const mine = (await client.listComments(pr.number)).find(
          (c) => isSelf(c.user, viewer) && (c.body ?? "").includes(COMMENT_MARKER),
        );
        if (mine) await client.updateComment(mine.id, body);
        else await client.createComment(pr.number, body);
      },
      () =>
        io.warning(
          "Could not write the PR comment (403): the token needs `pull-requests: write`. Fork PRs get a read-only token on `pull_request` events.",
        ),
    );
  }

  if (d.inputs.labels) {
    const want = `risk:${result.tier}`;
    const current = pr.labels.map((l) => l.name);
    await unlessForbidden(
      async () => {
        for (const label of current) if (RISK_LABELS.includes(label) && label !== want) await client.removeLabel(pr.number, label);
        if (!current.includes(want)) await client.addLabels(pr.number, [want]);
      },
      () => io.warning("Could not set risk labels (403): the token needs `pull-requests: write` (and `issues: write` to create new labels)."),
    );
  }

  io.summary(body);
  return { score: result.score, tier: result.tier, decision: result.policy.decision, approved: approval.approved };
}

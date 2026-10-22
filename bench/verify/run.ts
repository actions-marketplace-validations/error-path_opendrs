/**
 * bench/verify: precision/recall study of `llm.verify` (the Phase 2 verification pass) against
 * the field-test corpus (docs/research/2026-10-19-field-test.md; bench/verify/labels.json).
 *
 * Needs a `dist/` build of the verification-pass core branches (Tasks 1-4 of
 * docs/superpowers/plans/2026-10-22-verification-pass.md — `llm.verify.enabled`,
 * `brief.verification`, etc. do not exist on `main` yet) and
 * ~/.config/opendrs/bench.env holding ANTHROPIC_API_KEY. See README.md for prerequisites, flags
 * and exit codes.
 *
 * Node >= 23.6 (type stripping), same style as bench/apachejit/run.ts.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { defaultConfig, type OpendrsConfig } from "../../dist/domain/config.js";
import { OpendrsError } from "../../dist/domain/types.js";
import type { LlmProvider, ReviewBrief } from "../../dist/domain/types.js";
import { scoreDiff } from "../../dist/engine.js";
import { createLlmProvider } from "../../dist/llm/provider.js";
import { VERSION } from "../../dist/version.js";
import {
  estimateCallCostUsd,
  evaluateDecisionRule,
  factId,
  flattenLabels,
  groupByFactId,
  PRICES,
  reconcileActualSpend,
  reserveIfAffordable,
  tallyLabels,
  type Budget,
  type FlatLabelledFact,
  type LabelsFile,
} from "./lib.ts";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const BENCH_ENV_PATH = join(homedir(), ".config/opendrs/bench.env");
const REPOS_DIR = join(homedir(), ".cache/opendrs/field-test/repos");
const STUDY_DIR_ROOT = join(homedir(), ".cache/opendrs/verify-study");
/** Rough estimate of the verifier's fixed system-prompt + schema overhead, in characters, until
 * the real VERIFY_SYSTEM_PROMPT/VERIFY_SCHEMA exist in dist/ (same role as apachejit/llm.ts's
 * PROMPT_CHARS constant for the judge). Re-measure once llm.ts's `verifyPromptHash()` is real. */
const VERIFY_SYSTEM_PROMPT_CHARS_ESTIMATE = 3_000;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Removes every occurrence of `secret` from `text`. Used on every error message/log line before
 * it is printed, written or included in a report — the key must never reach stdout, stderr, or a
 * file, under any error path. */
function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

/** Parses `KEY=VALUE` lines (blank lines and `#` comments ignored); does not touch process.env. */
function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/**
 * Reads ANTHROPIC_API_KEY from ~/.config/opendrs/bench.env. Refuses with a clear message if the
 * file or the key is missing — never falls back to process.env or any other source, so a stray
 * key in the worker's own shell can never be used by accident (rule 7: no API calls by the
 * worker; this script is only ever run by the lead, with their own key).
 */
async function loadApiKey(): Promise<string> {
  if (!existsSync(BENCH_ENV_PATH)) {
    usageError(
      `Missing ${BENCH_ENV_PATH}. Create it with one line, ANTHROPIC_API_KEY=sk-ant-..., and re-run. ` +
        `This script never reads the key from process.env or anywhere else, and never runs a paid call without it.`,
    );
  }
  const env = parseEnvFile(await readFile(BENCH_ENV_PATH, "utf8"));
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    usageError(`${BENCH_ENV_PATH} has no ANTHROPIC_API_KEY=... line. Add one and re-run.`);
  }
  return key;
}

interface Options {
  model: string;
  maxUsd: number;
  repos?: string[];
  dryRun: boolean;
  keepClones: boolean;
  out: string;
}

function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string", default: "claude-sonnet-5" },
      "max-usd": { type: "string", default: "5.00" },
      repos: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "keep-clones": { type: "boolean", default: false },
      out: { type: "string", default: fileURLToPath(new URL("results.md", import.meta.url)) },
    },
  });
  if (!PRICES[values.model]) usageError(`--model must be one of ${Object.keys(PRICES).join(", ")} (needed for the spend cap)`);
  const maxUsd = Number(values["max-usd"]);
  if (!(maxUsd > 0)) usageError(`--max-usd must be a positive number, got "${values["max-usd"]}"`);
  return {
    model: values.model,
    maxUsd,
    repos: values.repos?.split(",").map((s) => s.trim()),
    dryRun: values["dry-run"],
    keepClones: values["keep-clones"],
    out: values.out,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1 << 30 });
  return stdout.trim();
}

interface LabelledRepoLike {
  repo: string;
  slug: string;
  head: string;
  cloneMode?: string;
  config?: Record<string, unknown>;
}

/** Clones `repo` under REPOS_DIR/<slug> at its pinned head, reusing an existing clone. Blobless
 * (`--filter=blob:none`) unless `cloneMode` names a full clone (fastlane needs one; see
 * labels.json's meta.setupQuirks.fastlane). */
async function ensureClone(repo: LabelledRepoLike): Promise<string> {
  const dir = join(REPOS_DIR, repo.slug);
  const url = `https://github.com/${repo.repo}.git`;
  if (!existsSync(dir)) {
    const partial = `${dir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    const full = repo.cloneMode?.toLowerCase().includes("full") ?? false;
    console.error(`${repo.slug}: cloning ${url}${full ? " (full clone)" : " (blobless)"}`);
    const args = full ? ["clone", "-q", url, partial] : ["clone", "-q", "--filter=blob:none", url, partial];
    await execFileAsync("git", args, { maxBuffer: 1 << 30 });
    await git(partial, ["rename" as never]).catch(() => undefined); // no-op guard; rename is done by fs below
  }
  if (existsSync(`${dir}.partial`) && !existsSync(dir)) {
    const { rename } = await import("node:fs/promises");
    await rename(`${dir}.partial`, dir);
  }
  await git(dir, ["rev-parse", "--verify", `${repo.head}^{commit}`]).catch(() => {
    throw new Error(`${repo.slug}: pinned head ${repo.head} not found in the clone at ${dir}`);
  });
  return dir;
}

/** Applies a repo's labels.json `config` overrides (currently only fastlane's history.* tuning)
 * onto a fresh defaultConfig(). Keys are dotted ("history.maxCommits"); unknown/non-numeric keys
 * (e.g. the human-readable "note" field) are skipped. */
function applyConfigOverrides(config: OpendrsConfig, overrides: Record<string, unknown> | undefined): void {
  if (!overrides) return;
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "number") continue; // skips "note"
    if (key === "history.maxCommits") config.history.maxCommits = value;
    else if (key === "history.lookbackDays") config.history.lookbackDays = value;
  }
}

/** Builds the config this PR scores with: real defaults plus the repo's setup quirks plus the
 * verifier turned on. */
function buildConfig(repo: LabelledRepoLike, model: string): OpendrsConfig {
  const config = defaultConfig();
  applyConfigOverrides(config, repo.config);
  config.llm.enabled = true;
  config.llm.provider = "anthropic";
  config.llm.model = model;
  // llm.verify.* (Task 2 of the verification-pass plan): guarded so a dist build that predates
  // Phase 2 fails with a clear message instead of a silent no-op.
  if (!("verify" in config.llm)) {
    throw new Error("config.llm.verify is missing: this dist/ build predates the verification-pass core branches (Tasks 1-4). Build from a branch that includes them first.");
  }
  (config.llm as unknown as { verify: { enabled: boolean } }).verify.enabled = true;
  return config;
}

/** A rough proxy for the verifier prompt's size before the real VERIFY_SYSTEM_PROMPT/VERIFY_SCHEMA
 * exist: the baseline (verify-off) brief's own JSON size, which scales with the same candidate
 * pools (facts, reviewFirst hunks, checks) the verifier call would see, plus a fixed overhead. */
function estimatePromptChars(baseline: ReviewBrief): number {
  return VERIFY_SYSTEM_PROMPT_CHARS_ESTIMATE + JSON.stringify({ facts: baseline.captain?.facts ?? [], reviewFirst: baseline.reviewFirst, checks: baseline.checks }).length;
}

interface PrOutcome {
  repoSlug: string;
  prSlug: string;
  skipped?: string;
  baseline?: ReviewBrief;
  verified?: ReviewBrief;
  estimatedCost?: number;
  actualCost?: number;
}

async function scorePr(repoDir: string, repo: LabelledRepoLike, pr: { base: string; head: string; slug: string }, model: string, dryRun: boolean, apiKeyEnv: Record<string, string> | undefined, budget: Budget | undefined): Promise<PrOutcome> {
  const baselineConfig = defaultConfig();
  applyConfigOverrides(baselineConfig, repo.config);
  const baselineResult = await scoreDiff({ repoDir, config: baselineConfig, base: pr.base, head: pr.head, llm: null, brief: {} });
  if (!baselineResult.brief) return { repoSlug: repo.slug, prSlug: pr.slug, skipped: "scoreDiff did not build a baseline brief" };
  const baseline = baselineResult.brief;

  if (dryRun) return { repoSlug: repo.slug, prSlug: pr.slug, baseline };

  const estimatedCost = estimateCallCostUsd(estimatePromptChars(baseline), PRICES[model]!);
  if (!budget) return { repoSlug: repo.slug, prSlug: pr.slug, baseline, estimatedCost };
  const reserved = reserveIfAffordable(budget, estimatePromptChars(baseline));
  if (!reserved.ok) {
    return { repoSlug: repo.slug, prSlug: pr.slug, baseline, estimatedCost: reserved.estimatedCost, skipped: "budget" };
  }

  const config = buildConfig(repo, model);
  let provider: LlmProvider | undefined;
  try {
    provider = createLlmProvider(config, apiKeyEnv as unknown as NodeJS.ProcessEnv);
  } catch (e) {
    budget.left += reserved.estimatedCost; // refund: the call never happened
    throw e instanceof OpendrsError ? new Error(scrub(e.message, undefined)) : e;
  }
  const result = await scoreDiff({ repoDir, config, base: pr.base, head: pr.head, llm: provider, brief: {} });
  const verified = result.brief ?? baseline;
  const usage = verified.verification?.usage;
  const actualCost = usage ? reconcileActualSpend(budget, reserved.estimatedCost, usage) : (budget.left += reserved.estimatedCost, 0);
  return { repoSlug: repo.slug, prSlug: pr.slug, baseline, verified, estimatedCost: reserved.estimatedCost, actualCost };
}

/** Recall/precision bookkeeping for one labelled fact group (several field-test instances can
 * share one factId; see lib.ts's groupByFactId doc comment). `verdict` is the live
 * `brief.verification.verdicts[id]` entry, when the PR was actually scored with verify on. */
interface Judged {
  id: string;
  facts: FlatLabelledFact[];
  verdict?: { action: string; status: string; reason?: string; source: string; droppedClass?: string };
  detectorHandledClass?: "A" | "B" | "C"; // inferred from the labelled note mentioning the deterministic classes, spec §3.8
}

function judgeGroup(id: string, facts: FlatLabelledFact[], verified: ReviewBrief | undefined): Judged {
  const verdict = verified?.verification?.verdicts?.[id];
  const note = facts.map((f) => f.note ?? "").join(" ");
  const detectorHandledClass = /class a \(retired file\)/i.test(note) ? "A" : /class b \(partner lacks/i.test(note) ? "B" : /class c \(test fired/i.test(note) ? "C" : undefined;
  return { id, facts, verdict, detectorHandledClass };
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  const labels = JSON.parse(await readFile(join(HERE, "labels.json"), "utf8")) as LabelsFile;
  const flat = flattenLabels(labels);
  console.error("Traced label totals:", tallyLabels(flat));

  const apiKey = o.dryRun ? undefined : await loadApiKey();
  const apiKeyEnv = apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : undefined;
  const budget: Budget | undefined = o.dryRun ? undefined : { left: o.maxUsd, prices: PRICES[o.model]! };

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const studyDir = join(STUDY_DIR_ROOT, runId);
  await mkdir(studyDir, { recursive: true });

  const repos = labels.repos.filter((r) => !o.repos || o.repos.includes(r.slug));
  const outcomes: PrOutcome[] = [];
  const clonedDirs: string[] = [];
  let aborted = false;

  outer: for (const repo of repos) {
    let repoDir: string;
    try {
      repoDir = await ensureClone(repo);
      clonedDirs.push(repoDir);
    } catch (e) {
      console.error(`${repo.slug}: skipped, ${scrub(errorMessage(e), apiKey)}`);
      continue;
    }
    for (const pr of repo.prs) {
      if (aborted) break outer;
      let outcome: PrOutcome;
      try {
        outcome = await scorePr(repoDir, repo, { base: pr.base, head: pr.head, slug: pr.slug }, o.model, o.dryRun, apiKeyEnv, budget);
      } catch (e) {
        outcome = { repoSlug: repo.slug, prSlug: pr.slug, skipped: scrub(errorMessage(e), apiKey) };
      }
      if (outcome.skipped === "budget") {
        console.error(`ABORTING: ${repo.slug}/${pr.slug} would need ~$${outcome.estimatedCost?.toFixed(4)}, only $${budget?.left.toFixed(4)} left of --max-usd ${o.maxUsd}. Stopping before any further calls.`);
        aborted = true;
        outcomes.push(outcome);
        break outer;
      }
      if (!o.dryRun) console.error(`spend so far: $${(o.maxUsd - (budget?.left ?? o.maxUsd)).toFixed(4)} of $${o.maxUsd}`);
      outcomes.push(outcome);
      if (outcome.verified) {
        await writeFile(join(studyDir, `${repo.slug}-${pr.slug}.json`), JSON.stringify(outcome.verified, null, 2));
      } else if (outcome.baseline) {
        await writeFile(join(studyDir, `${repo.slug}-${pr.slug}.baseline.json`), JSON.stringify(outcome.baseline, null, 2));
      }
    }
  }

  // --- recall / precision / cost, from the labelled facts matched against live verdicts ---
  const outcomeByPr = new Map(outcomes.map((o2) => [`${o2.repoSlug}:${o2.prSlug}`, o2]));
  const groups = groupByFactId(flat);
  const judged: Judged[] = [];
  for (const [id, facts] of groups) {
    const first = facts[0]!;
    const outcome = outcomeByPr.get(`${first.repoSlug}:${first.prSlug}`);
    judged.push(judgeGroup(id, facts, outcome?.verified));
  }

  const trueUsefulGroups = judged.filter((j) => j.facts.some((f) => f.label === "true-useful"));
  const trueUsefulWronglyDropped = trueUsefulGroups.filter((j) => j.verdict?.action === "drop").length;
  const trueUsefulTotal = flat.filter((f) => f.label === "true-useful").length;

  const couplingGroups = judged.filter((j) => j.facts.some((f) => f.id === "coupling.missing" && f.label === "noise"));
  const couplingNoiseTotal = flat.filter((f) => f.id === "coupling.missing" && f.label === "noise").length;
  const couplingHandledByDetector = couplingGroups.filter((j) => j.detectorHandledClass !== undefined).reduce((n, j) => n + j.facts.length, 0);
  const couplingHandledByVerifier = couplingGroups.filter((j) => j.detectorHandledClass === undefined && (j.verdict?.action === "drop" || j.verdict?.action === "downgrade")).reduce((n, j) => n + j.facts.length, 0);
  const couplingNoiseHandled = Math.min(couplingNoiseTotal, couplingHandledByDetector + couplingHandledByVerifier);

  const wrongGroups = judged.filter((j) => j.facts.some((f) => f.label === "wrong"));
  const wrongFiresTotal = flat.filter((f) => f.label === "wrong").length;
  const wrongFiresHandled = wrongGroups.filter((j) => j.verdict?.action === "drop" || j.verdict?.action === "downgrade").reduce((n, j) => n + j.facts.length, 0);

  const scoredPrs = outcomes.filter((o2) => o2.actualCost !== undefined);
  const totalCost = scoredPrs.reduce((n, o2) => n + (o2.actualCost ?? 0), 0);
  const costPerPrUsd = scoredPrs.length > 0 ? totalCost / scoredPrs.length : 0;

  const decision = o.dryRun
    ? undefined
    : evaluateDecisionRule({ trueUsefulWronglyDropped, trueUsefulTotal, couplingNoiseHandled, couplingNoiseTotal, wrongFiresHandled, wrongFiresTotal, costPerPrUsd });

  const lines: string[] = [
    "# Verifier precision study: results",
    "",
    `Run: ${runId} · opendrs ${VERSION} · model ${o.model}${o.dryRun ? " · DRY RUN (no API calls)" : ""}`,
    `Raw per-PR JSON: ${studyDir}`,
    "",
    "## Recall (spec §3.7.1)",
    `${trueUsefulWronglyDropped} of ${trueUsefulTotal} true+useful facts wrongly dropped (bar: at most 1).`,
    "",
    "## Precision — coupling.missing (spec §3.7.2, §3.8 amendment)",
    `${couplingNoiseHandled} of ${couplingNoiseTotal} handled (detector classes A-C: ${couplingHandledByDetector}; verifier only: ${couplingHandledByVerifier}) — bar: >= 13 of 18 (70%).`,
    "",
    "## Precision — contract.dependency WRONG fires (spec §3.7.2)",
    `${wrongFiresHandled} of ${wrongFiresTotal} marked drop/downgrade (bar: both).`,
    "",
    "## Cost",
    `$${totalCost.toFixed(4)} total over ${scoredPrs.length} scored PRs; $${costPerPrUsd.toFixed(4)}/PR (bar: <= $0.02/PR). Model ${o.model}.`,
    "",
    "## Decision (spec §3.7, applied as written)",
    decision ? `recall: ${decision.recallPass ? "PASS" : "FAIL"} · precision: ${decision.precisionChecked ? (decision.precisionPass ? "PASS" : "FAIL") : "not checked (recall failed first)"} · cost: ${decision.costPass ? "PASS" : "FAIL"} · overall: ${decision.overall}` : "DRY RUN — no decision (no API calls were made; this only checks label matching against the baseline, verify-off brief).",
    "",
    "## Skipped / aborted PRs",
    ...outcomes.filter((o2) => o2.skipped).map((o2) => `- ${o2.repoSlug}/${o2.prSlug}: ${o2.skipped}`),
    aborted ? "\n**Run aborted by the budget cap before every labelled PR was scored.** Numbers above are partial." : "",
  ];
  await writeFile(o.out, `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.slice(0, lines.indexOf("## Skipped / aborted PRs")).join("\n")}\n`);

  if (!o.keepClones) {
    for (const dir of clonedDirs) await rm(dir, { recursive: true, force: true });
    console.error(`deleted ${clonedDirs.length} clone(s) under ${REPOS_DIR} (rule 7; pass --keep-clones to keep them)`);
  }

  if (aborted) return 3;
  if (outcomes.some((o2) => o2.skipped && o2.skipped !== "budget")) return 1;
  return 0;
}

process.exitCode = await main();

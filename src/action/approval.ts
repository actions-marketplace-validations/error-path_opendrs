import type { OpendrsConfig } from "../domain/config.js";
import type { ScoreResult } from "../domain/types.js";
import { GitHubError, isSelf, unlessForbidden, type GitHubClient, type Review } from "./github.js";
import { selfModifiedPaths } from "./guard.js";
import type { PullRequest } from "./run.js";
import type { WorkflowIO } from "./workflow.js";

export const APPROVAL_MARKER = "<!-- opendrs-approval -->";

const APPROVAL_FORBIDDEN =
  "GitHub refused the approval (403). In Settings > Actions > General > Workflow permissions, enable " +
  "\"Allow GitHub Actions to create and approve pull requests\", and give the job `pull-requests: write`.";

export interface ApprovalInput {
  client: GitHubClient;
  io: WorkflowIO;
  pr: PullRequest;
  config: OpendrsConfig;
  result: ScoreResult;
  /** Every path the PR changes (both sides of renames). */
  files: string[];
  /** Login of the token's user (undefined = unknown); only its own marked approvals are ever dismissed. */
  viewer: string | undefined;
}

const isFork = (pr: PullRequest) => pr.head.repo?.full_name !== pr.base.repo.full_name;

function blockers({ config, result, files, pr }: ApprovalInput): string[] {
  const out: string[] = [];
  if (!config.autoApprove.enabled) out.push("autoApprove.enabled is false (comment-only mode)");
  if (result.policy.decision !== "auto-approve") out.push(`decision is ${result.policy.decision}`);
  const touched = selfModifiedPaths(files, [config.model.replace(/^\.\//, "")]);
  if (touched.length) {
    const shown = touched.slice(0, 5).join(", ") + (touched.length > 5 ? `, and ${touched.length - 5} more` : "");
    out.push(`self-modification guard: the PR changes ${shown}`);
  }
  if (isFork(pr)) out.push("the PR comes from a fork");
  return out;
}

/**
 * Approve (and queue or auto-merge) only when every rail passes; otherwise dismiss this
 * token's own earlier opendrs approvals. Returns a one-line status for the PR comment.
 */
export async function reconcileApproval(a: ApprovalInput): Promise<{ approved: boolean; status: string }> {
  const { client, io, pr, result } = a;
  const own = (await client.listReviews(pr.number)).filter(
    (r: Review) => r.state === "APPROVED" && isSelf(r.user, a.viewer) && (r.body ?? "").includes(APPROVAL_MARKER),
  );

  const reasons = blockers(a);
  if (reasons.length) {
    io.info(`Not approving: ${reasons.join("; ")}.`);
    const message =
      result.policy.decision !== "auto-approve"
        ? `Risk increased: ${result.tier} ${result.score.toFixed(2)}`
        : `opendrs approval withdrawn: ${reasons.join("; ")}`;
    for (const r of own) {
      await unlessForbidden(
        async () => {
          await client.dismissReview(pr.number, r.id, message);
          io.notice(`Dismissed opendrs's earlier approval: ${message}`);
        },
        (e) => io.warning(`Could not dismiss opendrs's earlier approval (${e.message}). Dismiss it by hand.`),
      );
    }
    return { approved: false, status: `not approved: ${reasons.join("; ")}.` };
  }

  // A push during scoring would otherwise get an approval meant for the commit before it.
  const current = await client.pullHeadSha(pr.number);
  if (current !== pr.head.sha) {
    io.notice(`The PR head moved to ${current} while opendrs scored ${pr.head.sha}: not approving. The run for the new head decides.`);
    return { approved: false, status: "not approved: a new commit was pushed while scoring; the next run decides." };
  }

  if (own.some((r) => r.commit_id === pr.head.sha)) {
    io.info("This head commit is already approved by opendrs.");
  } else {
    const body =
      `${APPROVAL_MARKER}\nApproved by opendrs: risk score ${result.score.toFixed(2)} (${result.tier}) ` +
      `for commit ${pr.head.sha}. Every auto-approval rule passed.`;
    const done = await unlessForbidden(
      () => client.approve(pr.number, pr.head.sha, body).then(() => true),
      () => io.warning(APPROVAL_FORBIDDEN),
    );
    if (!done) return { approved: false, status: "not approved: GitHub refused the approval (see the job log)." };
    io.notice(`Approved: risk ${result.score.toFixed(2)} (${result.tier}).`);
  }
  return { approved: true, status: `approved by opendrs${await enableMerge(a)}.` };
}

async function enableMerge({ client, io, pr, result }: ApprovalInput): Promise<string> {
  const method = result.policy.mergeMethod;
  if (method === "none") return "";
  try {
    const settings = await client.mergeSettings(pr.base.ref);
    if (method === "queue" && settings.hasMergeQueue) {
      await client.enqueue(pr.node_id, pr.head.sha);
      return "; added to the merge queue";
    }
    if (method === "queue") io.notice(`No merge queue on ${pr.base.ref}: enabling auto-merge instead.`);
    await client.enableAutoMerge(pr.node_id, settings.method, pr.head.sha);
    return "; auto-merge enabled";
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    io.warning(`Approved, but enabling ${method === "queue" ? "the merge queue or auto-merge" : "auto-merge"} failed: ${e.message}. Check that auto-merge is allowed in the repository settings.`);
    return "; enabling auto-merge failed (see the job log)";
  }
}

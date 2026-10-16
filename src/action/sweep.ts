import { OpendrsError } from "../domain/types.js";
import { git } from "../git/exec.js";
import { HOLD_LABEL } from "./approval.js";
import type { GitHubClient } from "./github.js";
import { LANDING_LABEL, runPullRequest, type ActionDeps, type PullRequest } from "./run.js";

/** The `schedule` and `workflow_dispatch` events have no PR payload: they sweep the PRs waiting out a landing delay. */
export const SWEEP_EVENTS = ["schedule", "workflow_dispatch"];

export interface SweepDeps extends ActionDeps {
  owner: string;
  repo: string;
}

interface PullNode {
  number: number;
  id: string;
  title: string;
  body: string | null;
  isDraft: boolean;
  author: { login: string; __typename: string } | null;
  labels: { nodes: Array<{ name: string }> };
  baseRefOid: string;
  baseRefName: string;
  baseRepository: { nameWithOwner: string } | null;
  headRefOid: string;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
}

const PULLS_QUERY = `query($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, labels: [$label], first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number id title body isDraft
        author { login __typename }
        labels(first: 100) { nodes { name } }
        baseRefOid baseRefName baseRepository { nameWithOwner }
        headRefOid headRefName headRepository { nameWithOwner }
      }
    }
  }
}`;

/** Open PRs labelled `label`, in the shape of the `pull_request` webhook payload. */
export async function listLabelledPulls(client: Pick<GitHubClient, "graphql">, owner: string, repo: string, label: string): Promise<PullRequest[]> {
  type Page = { repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PullNode[] } } };
  const out: PullRequest[] = [];
  let after: string | null = null;
  do {
    const page: Page = await client.graphql<Page>(PULLS_QUERY, { owner, name: repo, label, after });
    const { pageInfo, nodes } = page.repository.pullRequests;
    for (const n of nodes) {
      out.push({
        number: n.number,
        node_id: n.id,
        title: n.title,
        body: n.body,
        labels: n.labels.nodes,
        draft: n.isDraft,
        user: n.author ? { login: n.author.login, type: n.author.__typename === "Bot" ? "Bot" : "User" } : null,
        base: { sha: n.baseRefOid, ref: n.baseRefName, repo: { full_name: n.baseRepository?.nameWithOwner ?? `${owner}/${repo}` } },
        head: { sha: n.headRefOid, ref: n.headRefName, repo: n.headRepository && { full_name: n.headRepository.nameWithOwner } },
      });
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
  return out;
}

/**
 * Re-run the per-PR flow for every open PR labelled opendrs:landing, fetching each PR's head and base
 * into the checkout first. A PR on hold is skipped: the `unlabeled` event resumes it. One PR's error
 * is logged and the sweep goes on; the job fails if any PR failed.
 */
export async function runSweep(d: SweepDeps): Promise<void> {
  const { io } = d;
  const pulls = await listLabelledPulls(d.client, d.owner, d.repo, LANDING_LABEL);
  io.info(pulls.length ? `Sweeping ${pulls.length} open PR(s) labelled ${LANDING_LABEL}: ${pulls.map((p) => `#${p.number}`).join(", ")}.` : `No open PRs labelled ${LANDING_LABEL}.`);
  const failed: number[] = [];
  for (const pr of pulls) {
    if (pr.labels.some((l) => l.name === HOLD_LABEL)) {
      io.info(`PR #${pr.number}: on hold (${HOLD_LABEL}); skipped until the label is removed.`);
      continue;
    }
    await io.group(`PR #${pr.number}: ${pr.title}`, async () => {
      try {
        // The base too: a push to it during the sweep would otherwise leave the base commit missing.
        await git(d.repoDir, ["fetch", "-q", "origin", `refs/heads/${pr.base.ref}`, `refs/pull/${pr.number}/head`]);
        await runPullRequest(d, pr);
      } catch (e) {
        failed.push(pr.number);
        io.error(`PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }
  if (failed.length) throw new OpendrsError(`sweep: ${failed.length} of ${pulls.length} PR(s) failed: ${failed.map((n) => `#${n}`).join(", ")}`, "io");
}

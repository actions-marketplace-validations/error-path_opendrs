// Minimal GitHub REST + GraphQL client over fetch, covering only what the action needs.

export class GitHubError extends Error {
  constructor(
    message: string,
    /** HTTP status; GraphQL FORBIDDEN errors map to 403. */
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** Run `fn`; on a 403 call `onForbidden` and return undefined. Other errors propagate. */
export async function unlessForbidden<T>(fn: () => Promise<T>, onForbidden: (e: GitHubError) => void): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GitHubError && e.status === 403) {
      onForbidden(e);
      return undefined;
    }
    throw e;
  }
}

export interface GitHubUser {
  login: string;
  /** "Bot" for GitHub App installations such as GITHUB_TOKEN. */
  type?: string;
}

export interface IssueComment {
  id: number;
  body?: string | null;
  user: GitHubUser | null;
}

export interface Review {
  id: number;
  body?: string | null;
  state: string;
  user: GitHubUser | null;
  commit_id: string;
}

/** GraphQL names GITHUB_TOKEN "github-actions" while REST shows "github-actions[bot]". */
const normaliseLogin = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");

export const sameLogin = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && normaliseLogin(a) === normaliseLogin(b);

/**
 * Whether `user` is this token's account. When the identity is unknown (`viewer` undefined),
 * any bot account counts; callers also require the opendrs marker in the body.
 */
export function isSelf(user: GitHubUser | null, viewer: string | undefined): boolean {
  if (!user) return false;
  return viewer === undefined ? user.type === "Bot" : sameLogin(user.login, viewer);
}

/** An entry of GET /pulls/{n}/commits. `author` is GitHub's verified email-to-account mapping. */
export interface PullCommit {
  sha: string;
  author: { login: string } | null;
  commit: { author: { email: string } | null };
}

export type MergeMethod = "MERGE" | "SQUASH" | "REBASE";

export interface GitHubClientOptions {
  token: string;
  apiUrl: string;
  graphqlUrl: string;
  owner: string;
  repo: string;
}

export class GitHubClient {
  constructor(private readonly opts: GitHubClientOptions) {}

  private async send(method: string, url: string, body?: unknown): Promise<Response> {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "opendrs-action",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().then((d: { message?: string }) => d.message, () => undefined);
      throw new GitHubError(`GitHub ${method} ${new URL(url).pathname} failed: ${res.status} ${detail ?? res.statusText}`, res.status);
    }
    return res;
  }

  private rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send(method, this.opts.apiUrl + path, body).then((r) => r.json() as Promise<T>);
  }

  private async paginate<T>(path: string, pick: (page: unknown) => T[] = (p) => p as T[]): Promise<T[]> {
    const all: T[] = [];
    let url: string | undefined = `${this.opts.apiUrl}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      const res = await this.send("GET", url);
      all.push(...pick(await res.json()));
      url = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    }
    return all;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.send("POST", this.opts.graphqlUrl, { query, variables });
    const out = (await res.json()) as { data?: T; errors?: Array<{ type?: string; message: string }> };
    if (out.errors?.length) {
      const status = out.errors.some((e) => e.type === "FORBIDDEN") ? 403 : res.status;
      throw new GitHubError(`GitHub GraphQL failed: ${out.errors.map((e) => e.message).join("; ")}`, status);
    }
    return out.data as T;
  }

  private get repoPath() {
    return `/repos/${this.opts.owner}/${this.opts.repo}`;
  }

  /** Login of the token's own user, or undefined when neither GraphQL nor GET /user tells. */
  async viewerLogin(): Promise<string | undefined> {
    try {
      return (await this.graphql<{ viewer: { login: string } }>("query { viewer { login } }")).viewer.login;
    } catch {
      return this.rest<{ login: string }>("GET", "/user").then(
        (u) => u.login,
        () => undefined,
      );
    }
  }

  listComments(pr: number) {
    return this.paginate<IssueComment>(`${this.repoPath}/issues/${pr}/comments`);
  }
  async createComment(pr: number, body: string) {
    await this.rest("POST", `${this.repoPath}/issues/${pr}/comments`, { body });
  }
  async updateComment(id: number, body: string) {
    await this.rest("PATCH", `${this.repoPath}/issues/comments/${id}`, { body });
  }

  async addLabels(pr: number, labels: string[]) {
    await this.rest("POST", `${this.repoPath}/issues/${pr}/labels`, { labels });
  }
  /** Removing a label the PR does not have (404) is not an error. */
  async removeLabel(pr: number, label: string) {
    try {
      await this.rest("DELETE", `${this.repoPath}/issues/${pr}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 404)) throw e;
    }
  }

  /** The PR's current head sha. */
  async pullHeadSha(pr: number): Promise<string> {
    return (await this.rest<{ head: { sha: string } }>("GET", `${this.repoPath}/pulls/${pr}`)).head.sha;
  }

  /** The PR's commits, oldest first (GitHub lists at most 250). */
  listPullCommits(pr: number) {
    return this.paginate<PullCommit>(`${this.repoPath}/pulls/${pr}/commits`);
  }

  listReviews(pr: number) {
    return this.paginate<Review>(`${this.repoPath}/pulls/${pr}/reviews`);
  }
  async approve(pr: number, commitId: string, body: string) {
    await this.rest("POST", `${this.repoPath}/pulls/${pr}/reviews`, { event: "APPROVE", commit_id: commitId, body });
  }
  async dismissReview(pr: number, reviewId: number, message: string) {
    await this.rest("PUT", `${this.repoPath}/pulls/${pr}/reviews/${reviewId}/dismissals`, { message, event: "DISMISS" });
  }

  /**
   * Names of the latest check runs that concluded success on exactly `sha`. Never counts opendrs's
   * own job: the names of this workflow run's (`ownRunId`) unfinished Actions jobs, opendrs among
   * them, are left out, in this run and in earlier ones.
   */
  async successfulCheckNames(sha: string, ownRunId?: string): Promise<string[]> {
    type Run = { name: string; head_sha: string; status: string; conclusion: string | null; details_url?: string | null; app?: { slug: string } | null };
    const runs = await this.paginate<Run>(`${this.repoPath}/commits/${sha}/check-runs?filter=latest`, (p) => (p as { check_runs: Run[] }).check_runs);
    const own = new Set(
      runs
        .filter((r) => ownRunId && r.status !== "completed" && r.app?.slug === "github-actions" && r.details_url?.includes(`/actions/runs/${ownRunId}/`))
        .map((r) => r.name),
    );
    return runs.filter((r) => r.head_sha === sha && r.conclusion === "success" && !own.has(r.name)).map((r) => r.name);
  }

  /** Parameters of the active ruleset `pull_request` rules on `branch` (readable with the default token). */
  async pullRequestRules(branch: string): Promise<Array<{ required_approving_review_count?: number; dismiss_stale_reviews_on_push?: boolean }>> {
    type Rule = { type: string; parameters?: { required_approving_review_count?: number; dismiss_stale_reviews_on_push?: boolean } };
    const rules = await this.paginate<Rule>(`${this.repoPath}/rules/branches/${encodeURIComponent(branch)}`);
    return rules.filter((r) => r.type === "pull_request").map((r) => r.parameters ?? {});
  }

  /** Classic branch protection's review settings; reading them needs administration read, which GITHUB_TOKEN lacks. */
  async classicReviewProtection(branch: string): Promise<{ dismiss_stale_reviews?: boolean; required_approving_review_count?: number } | undefined> {
    type Protection = { required_pull_request_reviews?: { dismiss_stale_reviews?: boolean; required_approving_review_count?: number } };
    return (await this.rest<Protection>("GET", `${this.repoPath}/branches/${encodeURIComponent(branch)}/protection`)).required_pull_request_reviews;
  }

  /** Whether `branch` has a merge queue, and the first merge method the repo allows. */
  async mergeSettings(branch: string): Promise<{ hasMergeQueue: boolean; method: MergeMethod }> {
    const { repository: r } = await this.graphql<{
      repository: { mergeCommitAllowed: boolean; squashMergeAllowed: boolean; rebaseMergeAllowed: boolean; mergeQueue: { id: string } | null };
    }>(
      `query($owner: String!, $name: String!, $branch: String!) {
        repository(owner: $owner, name: $name) {
          mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
          mergeQueue(branch: $branch) { id }
        }
      }`,
      { owner: this.opts.owner, name: this.opts.repo, branch },
    );
    const method: MergeMethod = r.mergeCommitAllowed ? "MERGE" : r.squashMergeAllowed ? "SQUASH" : "REBASE";
    return { hasMergeQueue: r.mergeQueue !== null, method };
  }

  /** GitHub refuses both mutations when the PR head is no longer `expectedHeadOid`. */
  async enableAutoMerge(pullRequestId: string, mergeMethod: MergeMethod, expectedHeadOid: string) {
    await this.graphql(
      `mutation($id: ID!, $method: PullRequestMergeMethod, $head: GitObjectID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $head }) { clientMutationId }
      }`,
      { id: pullRequestId, method: mergeMethod, head: expectedHeadOid },
    );
  }

  async disableAutoMerge(pullRequestId: string) {
    await this.graphql(
      `mutation($id: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId }
      }`,
      { id: pullRequestId },
    );
  }

  async dequeue(pullRequestId: string) {
    await this.graphql(
      `mutation($id: ID!) {
        dequeuePullRequest(input: { id: $id }) { clientMutationId }
      }`,
      { id: pullRequestId },
    );
  }

  async enqueue(pullRequestId: string, expectedHeadOid: string) {
    await this.graphql(
      `mutation($id: ID!, $head: GitObjectID!) {
        enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { position } }
      }`,
      { id: pullRequestId, head: expectedHeadOid },
    );
  }
}

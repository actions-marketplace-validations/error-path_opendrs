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

export interface IssueComment {
  id: number;
  body?: string | null;
  user: { login: string } | null;
}

export interface Review {
  id: number;
  body?: string | null;
  state: string;
  user: { login: string } | null;
  commit_id: string;
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

  /** Login of the token's own user (e.g. "github-actions[bot]"). */
  async viewerLogin(): Promise<string> {
    try {
      return (await this.graphql<{ viewer: { login: string } }>("query { viewer { login } }")).viewer.login;
    } catch {
      return (await this.rest<{ login: string }>("GET", "/user")).login;
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

  listReviews(pr: number) {
    return this.paginate<Review>(`${this.repoPath}/pulls/${pr}/reviews`);
  }
  async approve(pr: number, commitId: string, body: string) {
    await this.rest("POST", `${this.repoPath}/pulls/${pr}/reviews`, { event: "APPROVE", commit_id: commitId, body });
  }
  async dismissReview(pr: number, reviewId: number, message: string) {
    await this.rest("PUT", `${this.repoPath}/pulls/${pr}/reviews/${reviewId}/dismissals`, { message, event: "DISMISS" });
  }

  async successfulCheckNames(sha: string): Promise<string[]> {
    type Run = { name: string; conclusion: string | null };
    const runs = await this.paginate<Run>(`${this.repoPath}/commits/${sha}/check-runs`, (p) => (p as { check_runs: Run[] }).check_runs);
    return runs.filter((r) => r.conclusion === "success").map((r) => r.name);
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

  async enableAutoMerge(pullRequestId: string, mergeMethod: MergeMethod) {
    await this.graphql(
      `mutation($id: ID!, $method: PullRequestMergeMethod) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId }
      }`,
      { id: pullRequestId, method: mergeMethod },
    );
  }

  async enqueue(pullRequestId: string) {
    await this.graphql(
      `mutation($id: ID!) {
        enqueuePullRequest(input: { pullRequestId: $id }) { mergeQueueEntry { position } }
      }`,
      { id: pullRequestId },
    );
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError } from "../../src/action/github.js";

const client = () =>
  new GitHubClient({ token: "tok", apiUrl: "https://ghe.example/api/v3", graphqlUrl: "https://ghe.example/api/graphql", owner: "o", repo: "r" });

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("GitHubClient", () => {
  it("sends the token and API version, against the configured API URL", async () => {
    const fetch = vi.fn(async () => json(200, []));
    vi.stubGlobal("fetch", fetch);
    await client().listComments(7);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ghe.example/api/v3/repos/o/r/issues/7/comments?per_page=100");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", "x-github-api-version": "2022-11-28" });
  });

  it("follows Link rel=next pagination", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, [{ id: 1 }], { link: '<https://ghe.example/api/v3/next?page=2>; rel="next", <x>; rel="last"' }))
      .mockResolvedValueOnce(json(200, [{ id: 2 }]));
    vi.stubGlobal("fetch", fetch);
    expect((await client().listReviews(7)).map((r) => r.id)).toEqual([1, 2]);
    expect(fetch.mock.calls[1]![0]).toBe("https://ghe.example/api/v3/next?page=2");
  });

  it("returns only successful check-run names across pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          200,
          { check_runs: [{ name: "claude-review", conclusion: "success" }, { name: "lint", conclusion: "failure" }] },
          { link: '<https://ghe.example/api/v3/p2>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(json(200, { check_runs: [{ name: "test", conclusion: null }, { name: "build", conclusion: "success" }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().successfulCheckNames("abc")).toEqual(["claude-review", "build"]);
  });

  it("throws GitHubError carrying the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { message: "Resource not accessible by integration" })));
    const err = await client().createComment(7, "x").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("Resource not accessible by integration");
  });

  it("treats removing a label that is not there as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(404, { message: "Label does not exist" })));
    await expect(client().removeLabel(7, "risk:red")).resolves.toBeUndefined();
  });

  it("URL-encodes label names", async () => {
    const fetch = vi.fn(async () => json(200, []));
    vi.stubGlobal("fetch", fetch);
    await client().removeLabel(7, "risk:red");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://ghe.example/api/v3/repos/o/r/issues/7/labels/risk%3Ared");
  });

  it("maps a GraphQL FORBIDDEN error to status 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { errors: [{ type: "FORBIDDEN", message: "nope" }] })));
    const err = await client().enqueue("PR_1").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(403);
  });

  it("falls back to GET /user when the GraphQL viewer query fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, { errors: [{ type: "FORBIDDEN", message: "no viewer" }] }))
      .mockResolvedValueOnce(json(200, { login: "octo-bot" }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().viewerLogin()).toBe("octo-bot");
  });

  it("picks the first allowed merge method and reports the merge queue", async () => {
    const fetch = vi.fn(async () =>
      json(200, { data: { repository: { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, mergeQueue: { id: "MQ" } } } }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await client().mergeSettings("main")).toEqual({ hasMergeQueue: true, method: "SQUASH" });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.variables).toEqual({ owner: "o", name: "r", branch: "main" });
  });
});

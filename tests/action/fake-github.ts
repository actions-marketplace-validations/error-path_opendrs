import { vi } from "vitest";

export const API = "https://api.github.com";
export const REPO = "o/r";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
}
export interface FakeReview {
  id: number;
  body: string;
  state: string;
  user: { login: string };
  commit_id: string;
}

export type Op =
  | "viewer"
  | "listComments"
  | "createComment"
  | "updateComment"
  | "addLabels"
  | "removeLabel"
  | "listReviews"
  | "createReview"
  | "dismissReview"
  | "checkRuns"
  | "mergeSettings"
  | "enableAutoMerge"
  | "enqueue";

export interface FakeGitHub {
  viewer: string;
  comments: FakeComment[];
  labels: string[];
  reviews: FakeReview[];
  checkRuns: Array<{ name: string; conclusion: string | null }>;
  mergeQueue: boolean;
  mergeCommitAllowed: boolean;
  /** Operations that answer 403. */
  forbid: Set<Op>;
  /** Operations that answer 500. */
  fail: Set<Op>;
  /** Every operation performed, with its payload. */
  log: Array<{ op: Op; body?: unknown; path: string }>;
  ops(op: Op): Array<{ op: Op; body?: unknown; path: string }>;
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

/** Stub global fetch with a small in-memory GitHub for PR #7 of o/r. */
export function installFakeGitHub(init: Partial<FakeGitHub> = {}): FakeGitHub {
  const gh: FakeGitHub = {
    viewer: "github-actions[bot]",
    comments: [],
    labels: [],
    reviews: [],
    checkRuns: [],
    mergeQueue: false,
    mergeCommitAllowed: true,
    forbid: new Set(),
    fail: new Set(),
    log: [],
    ops: (op) => gh.log.filter((e) => e.op === op),
    ...init,
  };
  let nextId = 1000;

  const handle = (op: Op, path: string, body: unknown, ok: () => Response): Response => {
    gh.log.push({ op, body, path });
    if (gh.forbid.has(op)) return json(403, { message: "Resource not accessible by integration" });
    if (gh.fail.has(op)) return json(500, { message: "Server Error" });
    return ok();
  };

  const graphql = (query: string, variables: Record<string, unknown>): Response => {
    // GraphQL reports failures as 200 with an `errors` array.
    const gql = (op: Op, data: () => unknown) => {
      gh.log.push({ op, body: variables, path: "/graphql" });
      if (gh.forbid.has(op)) return json(200, { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
      if (gh.fail.has(op)) return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request is in clean status" }] });
      return json(200, { data: data() });
    };
    if (query.includes("viewer")) return gql("viewer", () => ({ viewer: { login: gh.viewer } }));
    if (query.includes("enablePullRequestAutoMerge")) return gql("enableAutoMerge", () => ({ enablePullRequestAutoMerge: { clientMutationId: null } }));
    if (query.includes("enqueuePullRequest")) return gql("enqueue", () => ({ enqueuePullRequest: { mergeQueueEntry: { position: 1 } } }));
    if (query.includes("mergeQueue"))
      return gql("mergeSettings", () => ({
        repository: {
          mergeCommitAllowed: gh.mergeCommitAllowed,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          mergeQueue: gh.mergeQueue ? { id: "MQ_1" } : null,
        },
      }));
    throw new Error(`fake GitHub: unexpected GraphQL ${query}`);
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const path = url.pathname;
      const route = `${method} ${path}`;
      const pr = `/repos/${REPO}`;
      let m: RegExpMatchArray | null;

      if (route === "POST /graphql") return graphql(body.query, body.variables ?? {});
      if (route === `GET ${pr}/issues/7/comments`) return handle("listComments", path, undefined, () => json(200, gh.comments));
      if (route === `POST ${pr}/issues/7/comments`)
        return handle("createComment", path, body, () => {
          const c = { id: nextId++, body: body.body, user: { login: gh.viewer } };
          gh.comments.push(c);
          return json(201, c);
        });
      if ((m = route.match(new RegExp(`^PATCH ${pr}/issues/comments/(\\d+)$`))))
        return handle("updateComment", path, body, () => {
          const c = gh.comments.find((x) => x.id === Number(m![1]));
          if (!c) return json(404, { message: "Not Found" });
          c.body = body.body;
          return json(200, c);
        });
      if (route === `POST ${pr}/issues/7/labels`)
        return handle("addLabels", path, body, () => {
          for (const l of body.labels as string[]) if (!gh.labels.includes(l)) gh.labels.push(l);
          return json(200, gh.labels.map((name) => ({ name })));
        });
      if ((m = route.match(new RegExp(`^DELETE ${pr}/issues/7/labels/(.+)$`))))
        return handle("removeLabel", path, undefined, () => {
          const name = decodeURIComponent(m![1]!);
          if (!gh.labels.includes(name)) return json(404, { message: "Label does not exist" });
          gh.labels = gh.labels.filter((l) => l !== name);
          return json(200, gh.labels.map((n) => ({ name: n })));
        });
      if (route === `GET ${pr}/pulls/7/reviews`) return handle("listReviews", path, undefined, () => json(200, gh.reviews));
      if (route === `POST ${pr}/pulls/7/reviews`)
        return handle("createReview", path, body, () => {
          const r = { id: nextId++, body: body.body, state: "APPROVED", user: { login: gh.viewer }, commit_id: body.commit_id };
          gh.reviews.push(r);
          return json(200, r);
        });
      if ((m = route.match(new RegExp(`^PUT ${pr}/pulls/7/reviews/(\\d+)/dismissals$`))))
        return handle("dismissReview", path, body, () => {
          const r = gh.reviews.find((x) => x.id === Number(m![1]));
          if (!r) return json(404, { message: "Not Found" });
          r.state = "DISMISSED";
          return json(200, r);
        });
      if ((m = route.match(new RegExp(`^GET ${pr}/commits/(\\w+)/check-runs$`))))
        return handle("checkRuns", path, undefined, () => json(200, { total_count: gh.checkRuns.length, check_runs: gh.checkRuns }));
      throw new Error(`fake GitHub: unexpected ${route}`);
    }),
  );
  return gh;
}

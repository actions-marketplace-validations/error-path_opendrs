import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestRepo } from "../helpers/repo.js";

// The real git, wrapped so a test can inspect the args/opts buildHistoryIndex passes, or force a rejection.
vi.mock("../../src/git/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/git/exec.js")>();
  return { ...actual, git: vi.fn(actual.git) };
});
const { git } = await import("../../src/git/exec.js");
const { buildHistoryIndex } = await import("../../src/git/history.js");
const { parseConfig } = await import("../../src/domain/config.js");
const { OpendrsError } = await import("../../src/domain/types.js");
const { makeRepo } = await import("../helpers/repo.js");
const realGit = (await vi.importActual<typeof import("../../src/git/exec.js")>("../../src/git/exec.js")).git;

afterEach(() => vi.mocked(git).mockImplementation(realGit));

describe("buildHistoryIndex git timeout plumbing", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("passes history.gitTimeoutMs as the git log call's timeout", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const config = parseConfig({ history: { gitTimeoutMs: 42_000 } });
    await buildHistoryIndex(repo.dir, "HEAD", config);
    const logCall = vi.mocked(git).mock.calls.find((c) => c[1][0] === "log");
    expect(logCall?.[2]).toMatchObject({ timeoutMs: 42_000 });
  });

  it("adds actionable guidance (raise the timeout or lower maxCommits) to a timed-out git log error", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    vi.mocked(git).mockImplementation(async () => {
      throw new OpendrsError("git log timed out after 42s", "git");
    });
    await expect(buildHistoryIndex(repo.dir, "HEAD", parseConfig({}))).rejects.toThrow(
      "git log timed out after 42s while reading history; raise history.gitTimeoutMs or lower history.maxCommits",
    );
  });

  it("leaves a non-timeout git error unchanged", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    vi.mocked(git).mockImplementation(async () => {
      throw new OpendrsError("git log failed: fatal: bad object", "git");
    });
    await expect(buildHistoryIndex(repo.dir, "HEAD", parseConfig({}))).rejects.toThrow("git log failed: fatal: bad object");
  });
});

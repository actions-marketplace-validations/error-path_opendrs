import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feedbackCommand } from "../../src/cli/commands/feedback.js";
import { loadIncidents } from "../../src/model/label.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { testIo } from "./helpers.js";

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => repo.cleanup());

const lines = () =>
  readFileSync(join(repo.dir, ".opendrs/incidents.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const seed = (text: string) => {
  mkdirSync(join(repo.dir, ".opendrs"), { recursive: true });
  writeFileSync(join(repo.dir, ".opendrs/incidents.jsonl"), text);
};

describe("opendrs feedback", () => {
  it("records --inducing with fix, paths and note as a loadable incident", async () => {
    const bad = repo.commit({ "a.ts": "1\n" }, "feat: a");
    const fix = repo.commit({ "a.ts": "2\n" }, "fix: a");
    const { io, stdout } = testIo(repo.dir);
    expect(await feedbackCommand.run(["--inducing", "HEAD~1", "--fix", fix, "--paths", "a.ts, lib/", "--note", "SEV-1"], io)).toBe(0);
    expect(lines()).toEqual([{ inducing: bad, fix, paths: ["a.ts", "lib/"], note: "SEV-1" }]);
    expect(await loadIncidents(repo.dir)).toHaveLength(1);
    expect(stdout()).toContain(`Wrote to .opendrs/incidents.jsonl: {"inducing":"${bad}"`);
    expect(stdout()).toContain("Commit .opendrs/incidents.jsonl");
  });

  it("refuses a duplicate inducing/fix pair and exits 0", async () => {
    const bad = repo.commit({ "a.ts": "1\n" }, "feat: a");
    await feedbackCommand.run(["--inducing", bad], testIo(repo.dir).io);
    const { io, stdout } = testIo(repo.dir);
    expect(await feedbackCommand.run(["--inducing", bad], io)).toBe(0);
    expect(stdout()).toContain("Already recorded");
    expect(lines()).toHaveLength(1);
  });

  it("treats an abbreviated existing sha as the same incident", async () => {
    const bad = repo.commit({ "a.ts": "1\n" }, "feat: a");
    seed(`{"inducing":"${bad.slice(0, 7)}"}\n{"inducing":"deadbeef"}\n`);
    const { io, stdout } = testIo(repo.dir);
    expect(await feedbackCommand.run(["--inducing", bad], io)).toBe(0);
    expect(stdout()).toContain("Already recorded");
    expect(lines()).toHaveLength(2);
  });

  it("starts a new line when the file lacks a trailing newline", async () => {
    const first = repo.commit({ "a.ts": "1\n" }, "feat: a");
    const second = repo.commit({ "a.ts": "2\n" }, "feat: b");
    seed(`{"inducing":"${first}"}`);
    expect(await feedbackCommand.run(["--inducing", second], testIo(repo.dir).io)).toBe(0);
    expect(lines()).toEqual([{ inducing: first }, { inducing: second }]);
  });

  it("--pr finds a squash commit by its (#N) subject", async () => {
    repo.commit({ "a.ts": "1\n" }, "feat: a (#7)");
    const squash = repo.commit({ "b.ts": "1\n" }, "feat: b (#12)");
    repo.commit({ "c.ts": "1\n" }, "feat: c (#13)");
    repo.commit({ "d.ts": "1\n" }, "chore: d\n\nFollow-up to (#12)");
    const { io } = testIo(repo.dir);
    expect(await feedbackCommand.run(["--pr", "12", "--was-incident", "--note", "SEV-2"], io)).toBe(0);
    expect(lines()).toEqual([{ inducing: squash, note: "SEV-2" }]);
  });

  it("--pr records each commit a merge commit brought in", async () => {
    repo.commit({ "a.ts": "1\n" }, "init");
    repo.git("checkout", "-q", "-b", "topic");
    const c1 = repo.commit({ "b.ts": "1\n" }, "feat: b");
    const c2 = repo.commit({ "b.ts": "2\n" }, "feat: b more");
    repo.git("checkout", "-q", "main");
    repo.commit({ "a.ts": "2\n" }, "chore: main moves on");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge pull request #3 from org/topic", "topic");
    const { io } = testIo(repo.dir);
    expect(await feedbackCommand.run(["--pr", "3", "--was-incident"], io)).toBe(0);
    expect(lines().map((l) => l.inducing).sort()).toEqual([c1, c2].sort());
  });

  it("rejects bad usage", async () => {
    repo.commit({ "a.ts": "1\n" }, "feat: a (#1)");
    const { io } = testIo(repo.dir);
    await expect(feedbackCommand.run([], io)).rejects.toThrow("exactly one of --inducing");
    await expect(feedbackCommand.run(["--pr", "1"], io)).rejects.toThrow("--pr requires --was-incident");
    await expect(feedbackCommand.run(["--pr", "99", "--was-incident"], io)).rejects.toThrow("no commit on the current branch landed PR #99");
    await expect(feedbackCommand.run(["--inducing", "nope"], io)).rejects.toThrow("unknown commit: nope");
  });
});

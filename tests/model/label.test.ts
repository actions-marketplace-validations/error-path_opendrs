import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import type { Incident, LabelledCommit } from "../../src/domain/types.js";
import { buildHistoryIndex } from "../../src/git/history.js";
import { labelCommits, loadIncidents } from "../../src/model/label.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

async function label(repo: TestRepo, given?: Incident[]) {
  const incidents = given ?? (await loadIncidents(repo.dir));
  const config = defaultConfig();
  const history = await buildHistoryIndex(repo.dir, "HEAD", config);
  const labels = await labelCommits(repo.dir, history, config, incidents);
  return { labels, of: (sha: string) => labels.find((l) => l.sha === sha) };
}

const positive = (source: LabelledCommit["source"]) => ({ label: 1, source });

describe("loadIncidents", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("returns [] when the file is missing", async () => {
    repo = makeRepo();
    expect(await loadIncidents(repo.dir)).toEqual([]);
  });

  it("parses one incident per line and skips blank lines", async () => {
    repo = makeRepo();
    mkdirSync(join(repo.dir, ".opendrs"));
    writeFileSync(join(repo.dir, ".opendrs/incidents.jsonl"), '{"inducing":"abc1234","note":"outage"}\n\n{"fix":"def5678","paths":["src/pay"]}\n');
    expect(await loadIncidents(repo.dir)).toEqual([{ inducing: "abc1234", note: "outage" }, { fix: "def5678", paths: ["src/pay"] }]);
  });

  it("rejects malformed lines with the line number", async () => {
    repo = makeRepo();
    mkdirSync(join(repo.dir, ".opendrs"));
    writeFileSync(join(repo.dir, ".opendrs/incidents.jsonl"), '{"inducing":"abc1234"}\nnot json\n');
    await expect(loadIncidents(repo.dir)).rejects.toThrow(/line 2/);
  });
});

describe("labelCommits", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("labels every non-merge commit newest-first, 0 by default", async () => {
    repo = makeRepo();
    const a = repo.commit({ "a.ts": "1\n" }, "init");
    repo.git("checkout", "-q", "-b", "side");
    const b = repo.commit({ "b.ts": "1\n" }, "side");
    repo.git("checkout", "-q", "main");
    const c = repo.commit({ "c.ts": "1\n" }, "main");
    repo.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
    const { labels } = await label(repo);
    expect(labels).toEqual([
      { sha: c, label: 0 },
      { sha: b, label: 0 },
      { sha: a, label: 0 },
    ]);
  });

  it("labels the reverted commit as revert", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const bad = repo.commit({ "a.ts": "1\n2\n" }, "feat: risky");
    repo.git("revert", "--no-edit", bad);
    const { of } = await label(repo);
    expect(of(bad)).toMatchObject(positive("revert"));
  });

  it("blames the lines a fix deleted or modified (SZZ-lite)", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/a.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n" }, "init");
    const bug1 = repo.commit({ "src/a.ts": "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n" }, "tweak b");
    const bug2 = repo.commit({ "src/a.ts": "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 40;\n" }, "tweak d");
    const clean = repo.commit({ "src/other.ts": "x\n" }, "unrelated");
    const fix = repo.commit({ "src/a.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n" }, "fix: restore b and d");
    const { of } = await label(repo);
    expect(of(bug1)).toMatchObject(positive("szz"));
    expect(of(bug2)).toMatchObject(positive("szz"));
    expect(of(base)).toEqual({ sha: base, label: 0 });
    expect(of(clean)).toEqual({ sha: clean, label: 0 });
    expect(of(fix)).toEqual({ sha: fix, label: 0 });
  });

  it("ignores whitespace-only and comment-only lines, and ignored paths", async () => {
    repo = makeRepo();
    repo.commit({ "a.py": "x = 1\n", "package-lock.json": '{"v": 1}\n' }, "init");
    const comments = repo.commit({ "a.py": "x = 1\n# note\n\n    \n" }, "add comments");
    const lock = repo.commit({ "package-lock.json": '{"v": 2}\n' }, "bump lock");
    repo.commit({ "a.py": "x = 1\n", "package-lock.json": '{"v": 3}\n' }, "fix: tidy");
    const { of } = await label(repo);
    expect(of(comments)!.label).toBe(0);
    expect(of(lock)!.label).toBe(0);
  });

  it("follows the old path when the fix also renames the file", async () => {
    repo = makeRepo();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    repo.commit({ "old.ts": lines.join("\n") + "\n" }, "init");
    const bug = repo.commit({ "old.ts": [...lines.slice(0, 5), "BUG", ...lines.slice(6)].join("\n") + "\n" }, "change 5");
    repo.commit({ "old.ts": null, "new.ts": lines.join("\n") + "\n" }, "fix: move and restore");
    const { of } = await label(repo);
    expect(of(bug)).toMatchObject(positive("szz"));
  });

  it("does not fail on a root fix commit or on non-ASCII paths", async () => {
    repo = makeRepo();
    const root = repo.commit({ "ü dir/ä.ts": "a\nb\n" }, "fix: first");
    repo.commit({ "ü dir/ä.ts": "a\nc\n" }, "fix: second");
    const { of } = await label(repo);
    expect(of(root)).toMatchObject(positive("szz"));
  });

  it("labels incidents (inducing and blamed fix) with the highest precedence", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "init");
    const inducing = repo.commit({ "a.ts": "1\n2\n3\n4\n" }, "feat: four");
    repo.git("revert", "--no-edit", inducing);
    const blamed = repo.commit({ "b.ts": "one\ntwo\n" }, "feat: b");
    const fix = repo.commit({ "b.ts": "one\nTWO\n" }, "adjust b");
    const { of } = await label(repo, [{ inducing: inducing.slice(0, 8) }, { fix }]);
    expect(of(inducing)).toMatchObject(positive("incident"));
    expect(of(blamed)).toMatchObject(positive("incident"));
  });

  it("warns about incident shas that do not resolve instead of silently dropping them", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const known = repo.commit({ "a.ts": "1\n2\n" }, "feat: two");
    const config = defaultConfig();
    const history = await buildHistoryIndex(repo.dir, "HEAD", config);
    const warnings: string[] = [];
    const labels = await labelCommits(
      repo.dir,
      history,
      config,
      [{ inducing: "deadbeef00" }, { fix: "feedface00" }, { inducing: known.slice(0, 10) }],
      (w) => warnings.push(w),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/inducing commit deadbeef00 .*not counted/);
    expect(warnings[1]).toMatch(/fix commit feedface00 .*not counted/);
    expect(labels.find((l) => l.sha === known)).toMatchObject(positive("incident"));
    expect(labels.filter((l) => l.label === 1)).toHaveLength(1);
  });

  it("prefers revert over szz when both apply", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const bad = repo.commit({ "a.ts": "1\n2\n" }, "feat: two");
    // git revert's subject also matches the fix pattern, so SZZ blames `bad` too.
    repo.git("revert", "--no-edit", bad);
    const { of } = await label(repo);
    expect(of(bad)).toEqual({ sha: bad, label: 1, source: "revert" });
  });
});

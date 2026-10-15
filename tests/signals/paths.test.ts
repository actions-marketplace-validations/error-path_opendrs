import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig, type OpendrsConfig } from "../../src/domain/config.js";
import type { ChangedFile, ScoringContext, Signal } from "../../src/domain/types.js";
import { pathsSignals } from "../../src/signals/paths.js";

function ctxFor(files: ChangedFile[], config: OpendrsConfig = defaultConfig()): ScoringContext {
  return {
    repoDir: "/unused",
    trust: { authorVerified: true, historyComplete: true },
    diff: { base: "base", head: "head", files },
    config,
    history: { commits: [], fileCommits: () => [], fileCreator: () => undefined, authorCommitCount: () => 0 },
    readBase: async () => undefined,
    readHead: async () => undefined,
  };
}

function changed(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", added: 1, deleted: 0, binary: false, hunks: [], ignored: false, ...extra };
}

const byId = (signals: Signal[], id: string) => {
  const s = signals.find((x) => x.id === id);
  if (!s) throw new Error(`missing signal ${id}`);
  return s;
};

describe("paths signals", () => {
  it("are 0 and observed when nothing matches", async () => {
    const signals = await pathsSignals(ctxFor([changed("src/app.ts"), changed("README.md")]));
    expect(byId(signals, "paths.critical")).toMatchObject({ value: 0, status: "observed", evidence: [] });
    expect(byId(signals, "paths.blocked")).toMatchObject({ value: 0, status: "observed", evidence: [] });
  });

  it("flags critical paths with the matching files as evidence", async () => {
    const signals = await pathsSignals(ctxFor([changed("services/auth/login.ts"), changed("src/app.ts"), changed("billing/invoice.go")]));
    const s = byId(signals, "paths.critical");
    expect(s.value).toBe(1);
    expect(s.evidence.map((e) => e.file)).toEqual(["services/auth/login.ts", "billing/invoice.go"]);
    expect(s.evidence[0]?.detail).toContain("**/auth/**");
    expect(byId(signals, "paths.blocked").value).toBe(0);
  });

  it("flags blocked paths", async () => {
    const s = byId(await pathsSignals(ctxFor([changed(".github/workflows/ci.yml")])), "paths.blocked");
    expect(s.value).toBe(1);
    expect(s.evidence).toEqual([{ file: ".github/workflows/ci.yml", detail: 'matches block glob ".github/**"' }]);
  });

  it("matches block and critical globs case-insensitively", async () => {
    const signals = await pathsSignals(ctxFor([changed("Data/Migrations/1_Init.cs"), changed("src/Auth/login.ts")]));
    expect(byId(signals, "paths.blocked").evidence).toEqual([{ file: "Data/Migrations/1_Init.cs", detail: 'matches block glob "**/migrations/**"' }]);
    expect(byId(signals, "paths.critical").evidence.map((e) => e.file)).toEqual(["src/Auth/login.ts"]);
  });

  it("checks the old path of a rename, so moving a file out of a blocked path still counts", async () => {
    const moved = changed("scripts/001_init.sql", { status: "renamed", oldPath: "db/migrations/001_init.sql" });
    const s = byId(await pathsSignals(ctxFor([moved])), "paths.blocked");
    expect(s.value).toBe(1);
    expect(s.evidence).toEqual([
      { file: "scripts/001_init.sql", detail: 'renamed from db/migrations/001_init.sql, which matches block glob "**/migrations/**"' },
    ]);
  });

  it("checks the old path of a rename for critical paths too", async () => {
    const moved = changed("lib/session.ts", { status: "renamed", oldPath: "src/security/session.ts" });
    expect(byId(await pathsSignals(ctxFor([moved])), "paths.critical").value).toBe(1);
  });

  it("still counts ignored files, so ignore globs cannot bypass a block", async () => {
    const config = parseConfig({ paths: { block: ["**/*.lock"] } });
    const s = byId(await pathsSignals(ctxFor([changed("yarn.lock", { ignored: true })], config)), "paths.blocked");
    expect(s.value).toBe(1);
  });

  it("uses the configured globs on top of the defaults", async () => {
    const config = parseConfig({ paths: { critical: ["core/**"], block: ["infra/**"] } });
    const signals = await pathsSignals(ctxFor([changed("core/x.ts"), changed("src/auth/x.ts"), changed("infra/a.yml"), changed(".github/ci.yml")], config));
    expect(byId(signals, "paths.critical").evidence.map((e) => e.file)).toEqual(["core/x.ts", "src/auth/x.ts"]);
    expect(byId(signals, "paths.blocked").evidence.map((e) => e.file)).toEqual(["infra/a.yml", ".github/ci.yml"]);
  });

  it("drops a default block glob only through paths.unblock", async () => {
    const config = parseConfig({ paths: { unblock: [".github/**"] } });
    expect(byId(await pathsSignals(ctxFor([changed(".github/ci.yml")], config)), "paths.blocked").value).toBe(0);
  });
});

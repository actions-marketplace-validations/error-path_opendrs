# Inert changes (size-cap exemption) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop pure-docs, comment-only, and configured-exempt lines from counting toward
`autoApprove.maxChangedLines`, while leaving every other policy rule, the score itself, and
agent-instruction files (`CLAUDE.md` et al., which stay hard-counted) unchanged.

**Architecture:** One new pure function, `countedChangedLines(files, config)` in
`src/signals/size.ts`, implements the precedence from the spec (instructions > tests >
`sizeCapExempt` > docs-family > comment-only-hunk > else) by reusing the existing `inert()`
per-line test and `languageFamily()`. `src/policy/gate.ts`'s rule 2 calls it instead of its own
raw sum and reports both numbers when they differ. Three new config keys
(`paths.instructions`, `autoApprove.sizeCapExempt`, `autoApprove.countInertLines`) are added the
same way `paths.block`/`paths.critical` already work (additive defaults + `union`). A new strong
captain fact `contract.instructions` is detected in `src/architecture/contracts.ts` and registered
in `src/domain/types.ts` / `src/architecture/index.ts` next to the other `contract.*` facts.

**Tech Stack:** TypeScript (ESM, Node >= 22), zod for config schema, vitest for tests.

**Spec:** [docs/specs/2026-10-20-inert-changes-design.md](../../specs/2026-10-20-inert-changes-design.md)
(approved 2026-10-20; §8 has the five resolved decisions this plan implements).

## Global Constraints

- `paths.instructions` is additive only — like `paths.block`/`paths.critical`, a config's own list
  extends the default, there is no `unblock`-style removal (spec §3, §8.1).
- `autoApprove.countInertLines` defaults to `false` (new behaviour on by default) in this minor
  version — not a one-release opt-in (spec §5, §8.3).
- Precedence is fixed, first match wins (spec §2): instructions (full) > tests (full) >
  `sizeCapExempt` (zero) > docs-family (zero) > comment-only hunk (per-hunk zero) > else (full).
- `size.churn`, `size.relative`, `size.comment_only` signals keep reading every line unfiltered;
  only the gate's size-cap rule reads the smaller count (spec §1 non-goals).
- A binary file always counts as 1, whatever the precedence rule (never inert).
- A renamed file is never docs-exempt-by-rename-away and never comment-only (matches today's
  file-level `commentOnly` rule in `src/signals/size.ts`).
- `contract.instructions` ships now as a real strong `ArchitectureFact`, registered so
  `ArchitectureFactId`, `DETECTOR_RANK` and `src/architecture/index.ts`'s sort order stay
  consistent; add the new id/rank entry without renumbering any existing one (another branch is
  adding its own detector/fact id to the same files).
- Tests: only the files you touch, plus `npx tsc --noEmit`. Do not run the full suite or
  `npm run build:action`.

## Review Focus

- A PR that touches only `paths.instructions` files and nothing else must still trip the cap at
  the old, unfiltered count — the precedence's top rule, easy to get backwards if `countedLines`
  short-circuits to 0 for "docs-looking" files before checking instructions first.
- A single file with one comment-only hunk and one real-code hunk must only exclude the
  comment-only hunk's lines, not the whole file — a naive implementation might fall back to the
  file-level `commentOnly` boolean and zero or keep the whole file.
- `sizeCapExempt` matching a test file must NOT zero it — tests precedence must run before
  `sizeCapExempt`, even though a careless glob like `["**/**"]` would otherwise match everything.
- `countInertLines: true` must reproduce the exact old reason string (no "counted toward" suffix)
  so existing reason-string expectations (and anyone's `.opendrs.yml` automation reading the
  reason text) keep working byte-for-byte when a repo opts back into old behaviour.
- The `opendrs init` template must still parse to exactly `defaultConfig()` — a stray real
  (uncommented) `sizeCapExempt` line in the template would silently change the shipped defaults.

---

## File Structure

- Modify `src/domain/config.ts`: add `DEFAULT_INSTRUCTIONS`, `paths.instructions`,
  `autoApprove.sizeCapExempt`, `autoApprove.countInertLines`.
- Modify `src/signals/size.ts`: add `countedChangedLines(files, config)` and a private per-hunk
  helper, reusing the existing `inert()`.
- Modify `src/policy/gate.ts`: rule 2 calls `countedChangedLines`, builds the two-number reason.
- Modify `src/domain/types.ts`: add `"contract.instructions"` to `ArchitectureFactId`.
- Modify `src/architecture/contracts.ts`: detect `contract.instructions` facts.
- Modify `src/architecture/index.ts`: add `"contract.instructions"` to `DETECTOR_RANK`.
- Modify `src/cli/templates.ts`: add `paths.instructions` to `CONFIG_TEMPLATE`'s `paths:` block
  (full default list, like `block`), and a commented `sizeCapExempt` example under `autoApprove`.
- Modify `docs/policy.md`, `docs/auto-approve.md`, `docs/configuration.md`, `docs/captain.md`.
- Modify `CHANGELOG.md`: one `## Unreleased` `### Added` entry and one `### Changed` entry.
- Tests: `tests/domain/config.test.ts`, `tests/signals/size.test.ts`, `tests/policy/gate.test.ts`,
  `tests/architecture/contracts.test.ts`, `tests/cli/init-mcp.test.ts`.

---

### Task 1: Config keys (`paths.instructions`, `autoApprove.sizeCapExempt`, `autoApprove.countInertLines`)

**Files:**
- Modify: `src/domain/config.ts`
- Test: `tests/domain/config.test.ts`

**Interfaces:**
- Produces: `DEFAULT_INSTRUCTIONS: readonly string[]` (exported, like `DEFAULT_BLOCK`), and on
  `OpendrsConfig`: `paths.instructions: string[]`, `autoApprove.sizeCapExempt: string[]`,
  `autoApprove.countInertLines: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/domain/config.test.ts` (near the existing `describe("user paths.block, paths.critical and paths.unblock")` block):

```ts
describe("paths.instructions", () => {
  it("is additive like block and critical: a config's own list extends the defaults", () => {
    const defaults = defaultConfig().paths.instructions;
    expect(defaults).toContain("**/CLAUDE.md");
    expect(defaults).toContain(".claude/**");
    expect(parseConfig({ paths: { instructions: ["**/MY_AGENT.md"] } }).paths.instructions).toEqual([
      ...defaults,
      "**/MY_AGENT.md",
    ]);
  });

  it("has no unblock-style escape: there is no paths.uninstruct key", () => {
    expect(parseConfig({ paths: { uninstruct: ["**/CLAUDE.md"] } } as never).paths).not.toHaveProperty("uninstruct");
  });
});

describe("autoApprove.sizeCapExempt and autoApprove.countInertLines", () => {
  it("sizeCapExempt defaults to empty and gets the same glob validation as other lists", () => {
    expect(defaultConfig().autoApprove.sizeCapExempt).toEqual([]);
    expect(() => parseConfig({ autoApprove: { sizeCapExempt: ["[bad"] } })).toThrow(/sizeCapExempt.*\[ or \]/s);
  });

  it("countInertLines defaults to false", () => {
    expect(defaultConfig().autoApprove.countInertLines).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/domain/config.test.ts`
Expected: FAIL — `paths.instructions`/`autoApprove.sizeCapExempt`/`autoApprove.countInertLines`
are `undefined`, and the glob-validation error message does not mention `sizeCapExempt`.

- [ ] **Step 3: Implement**

In `src/domain/config.ts`, add after `DEFAULT_CRITICAL`:

```ts
/**
 * Default `paths.instructions`: files that steer an AI agent or CI, never inert for the size cap
 * (2026-10-20 inert-changes spec §3). Additive only, like DEFAULT_BLOCK/DEFAULT_CRITICAL — no
 * unblock-style removal.
 */
export const DEFAULT_INSTRUCTIONS: readonly string[] = [
  "**/CLAUDE.md",
  "**/AGENTS.md",
  "**/GEMINI.md",
  ".claude/**",
  ".cursor/**",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  ".github/instructions/**",
  "**/SKILL.md",
  "**/*.prompt.md",
  "**/prompts/**",
  ".opendrs/**",
];
```

In the `autoApprove` object (right after `maxChangedLines: z.number().int().positive().default(400),`):

```ts
      /** Never inert for the size cap (spec §2.3), whatever its language family; glob-matched like paths.*. */
      sizeCapExempt: globs([]),
      /** true restores pre-2026-10-20 behaviour: every changed line counts, nothing is excluded. */
      countInertLines: z.boolean().default(false),
```

In the `paths` object, add a field alongside `tests`:

```ts
      instructions: globs([]),
```

And in the `paths` `.transform`, add the union line next to `critical`:

```ts
      instructions: union(DEFAULT_INSTRUCTIONS, p.instructions),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/domain/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/config.ts tests/domain/config.test.ts
git commit -m "feat(config): add paths.instructions, autoApprove.sizeCapExempt, countInertLines"
```

---

### Task 2: `countedChangedLines` — the precedence helper

**Files:**
- Modify: `src/signals/size.ts`
- Test: `tests/signals/size.test.ts`

**Interfaces:**
- Consumes: `OpendrsConfig` (Task 1's new fields), `ChangedFile`/`Hunk` (`src/domain/types.ts`,
  unchanged), `changedLines(h: Hunk)` (`src/git/diff.ts`, existing), `matchAny` (`src/git/glob.ts`,
  existing), `isTestPath(config, path)` (`src/signals/tests.ts`, existing), `inert(line, family)`
  and `languageFamily(path)` (both already in this file / `./language.js`).
- Produces: `export function countedChangedLines(files: ChangedFile[], config: OpendrsConfig): number`
  — used by Task 3's `gate.ts`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `tests/signals/size.test.ts` (hand-built `ChangedFile`/`Hunk`
objects — no real git repo needed, since the function only reads diff shape and config):

```ts
import { parseConfig } from "../../src/domain/config.js";
import type { ChangedFile, Hunk } from "../../src/domain/types.js";
import { countedChangedLines } from "../../src/signals/size.js";

const hunk = (lines: string[]): Hunk => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines });

const changedFile = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  added: 0,
  deleted: 0,
  binary: false,
  hunks: [],
  ignored: false,
  ...over,
});

describe("countedChangedLines", () => {
  it("counts a binary file as 1 regardless of path", () => {
    const f = changedFile("CLAUDE.md", { binary: true });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });

  it("counts an instructions file in full even though it is also docs-family", () => {
    const f = changedFile("CLAUDE.md", { added: 50, deleted: 10, hunks: [hunk(Array(60).fill("+x"))] });
    expect(countedChangedLines([f], defaultConfig())).toBe(60);
  });

  it("counts a test file in full even when sizeCapExempt matches everything", () => {
    const config = parseConfig({ autoApprove: { sizeCapExempt: ["**/*"] } });
    const f = changedFile("tests/a.test.ts", { added: 40, deleted: 0, hunks: [hunk(Array(40).fill("+x"))] });
    expect(countedChangedLines([f], config)).toBe(40);
  });

  it("zeroes a file matched by autoApprove.sizeCapExempt", () => {
    const config = parseConfig({ autoApprove: { sizeCapExempt: ["notes/**"] } });
    const f = changedFile("notes/a.txt", { added: 30, deleted: 0, hunks: [hunk(Array(30).fill("+x"))] });
    expect(countedChangedLines([f], config)).toBe(0);
  });

  it("zeroes a docs-family file (.md) with no sizeCapExempt entry needed", () => {
    const f = changedFile("README.md", { added: 100, deleted: 5, hunks: [hunk(Array(105).fill("+x"))] });
    expect(countedChangedLines([f], defaultConfig())).toBe(0);
  });

  it("excludes only a comment-only hunk, counting a sibling real-code hunk in full", () => {
    const f = changedFile("src/a.ts", {
      added: 3,
      deleted: 0,
      hunks: [hunk(["+// just a comment", "+// another"]), hunk(["+const x = 1;"])],
    });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });

  it("a mixed hunk (one real-code line among comments) counts every line in that hunk", () => {
    const f = changedFile("src/a.ts", { hunks: [hunk(["+// comment", "+const x = 1;"])] });
    expect(countedChangedLines([f], defaultConfig())).toBe(2);
  });

  it("a renamed file is never comment-only even if every hunk line is a comment", () => {
    const f = changedFile("src/b.ts", { status: "renamed", oldPath: "src/a.ts", hunks: [hunk(["+// comment"])] });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });

  it("countInertLines: true restores the raw count, ignoring every exclusion", () => {
    const config = parseConfig({ autoApprove: { countInertLines: true } });
    const f = changedFile("README.md", { added: 20, deleted: 0 });
    expect(countedChangedLines([f], config)).toBe(20);
  });

  it("everything else (a plain source line) counts in full", () => {
    const f = changedFile("src/a.ts", { hunks: [hunk(["+const x = 1;"])] });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });
});
```

(`defaultConfig` is already imported at the top of `tests/signals/size.test.ts`'s sibling test
files; add `import { defaultConfig, parseConfig } from "../../src/domain/config.js";` to this
file's imports if not already present.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/signals/size.test.ts`
Expected: FAIL — `countedChangedLines` is not exported yet.

- [ ] **Step 3: Implement**

In `src/signals/size.ts`, add imports at the top:

```ts
import type { ChangedFile, Evidence, Hunk, ScoringContext, Signal, SignalProvider } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";
import { changedLines } from "../git/diff.js";
import { matchAny } from "../git/glob.js";
import { languageFamily, type LanguageFamily } from "./language.js";
import { isTestPath } from "./tests.js";
import { countedFiles, historyPath, plural, topEvidence, unknown } from "./util.js";
```

(`ChangedFile`, `Hunk`, `OpendrsConfig`, `changedLines`, `matchAny`, `isTestPath` are new; the
rest already exist in the file — merge into the existing import statements rather than
duplicating them.)

Add, after the existing `inert()` function:

```ts
/**
 * Spec 2026-10-20 §2/§3: the size cap's own line count, excluding inert lines in this order
 * (first match wins) — instructions file (full) > test file (full) > autoApprove.sizeCapExempt
 * (zero) > docs-family file (zero) > comment-only hunk (per-hunk zero) > everything else (full).
 * `countInertLines: true` restores the pre-2026-10-20 raw count exactly.
 */
export function countedChangedLines(files: ChangedFile[], config: OpendrsConfig): number {
  if (config.autoApprove.countInertLines) {
    return files.reduce((n, f) => n + (f.binary ? 1 : f.added + f.deleted), 0);
  }
  return files.reduce((n, f) => n + fileCountedLines(f, config), 0);
}

function fileCountedLines(f: ChangedFile, config: OpendrsConfig): number {
  const full = f.added + f.deleted;
  if (f.binary) return 1;
  if (matchAny(config.paths.instructions, f.path, { ignoreCase: true })) return full;
  if (isTestPath(config, f.path)) return full;
  if (matchAny(config.autoApprove.sizeCapExempt, f.path)) return 0;
  const family = languageFamily(f.path);
  if (family === "docs") return 0;
  if (f.status === "renamed") return full; // never comment-only, same as size.comment_only
  return f.hunks.reduce((n, h) => n + hunkCountedLines(h, family), 0);
}

/** 0 when every changed (+/-) line in the hunk is inert; otherwise its full changed-line count. */
function hunkCountedLines(h: Hunk, family: LanguageFamily): number {
  let count = 0;
  let allInert = true;
  for (const { kind, text } of changedLines(h)) {
    if (kind !== "+" && kind !== "-") continue;
    count++;
    if (!inert(text, family)) allInert = false;
  }
  return allInert ? 0 : count;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/signals/size.test.ts`
Expected: PASS

- [ ] **Step 5: Run `npx tsc --noEmit`**

Expected: no errors (the new imports must resolve and `Hunk`/`OpendrsConfig` types must line up).

- [ ] **Step 6: Commit**

```bash
git add src/signals/size.ts tests/signals/size.test.ts
git commit -m "feat(signals): add countedChangedLines, the size-cap inert-line precedence"
```

---

### Task 3: Gate change — the size-cap rule reads `countedChangedLines`

**Files:**
- Modify: `src/policy/gate.ts`
- Test: `tests/policy/gate.test.ts`

**Interfaces:**
- Consumes: `countedChangedLines(files, config)` from Task 2.
- Produces: unchanged `decide()` signature; `reasons` now sometimes carries the two-number
  sentence instead of the single-number one.

- [ ] **Step 1: Write the failing tests**

Add to `tests/policy/gate.test.ts`'s `describe("decide: rule 2 (size cap)")` block. First add a
helper near the top of the file (next to the existing `file` helper) for building a file with a
real hunk:

```ts
const hunk = (lines: string[]) => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines });
const fileWithHunks = (path: string, hunks: ReturnType<typeof hunk>[], added: number, deleted: number): ChangedFile => ({
  path,
  status: "modified",
  added,
  deleted,
  binary: false,
  hunks,
  ignored: false,
});
```

Then the tests:

```ts
it("excludes a pure-docs PR from the size cap entirely", () => {
  const f = fileWithHunks("README.md", [hunk(Array(500).fill("+x"))], 500, 0);
  const out = decide(input({ files: [f], cfg: { autoApprove: { maxChangedLines: 400 } } }));
  expect(out.decision).toBe("auto-approve");
  expect(out.reasons.some((r) => /maxChangedLines/.test(r))).toBe(false);
});

it("reports both numbers when inert lines were excluded", () => {
  const docs = fileWithHunks("README.md", [hunk(Array(300).fill("+x"))], 300, 0);
  const code = fileWithHunks("src/a.ts", [hunk(Array(200).fill("+const x = 1;"))], 200, 0);
  const out = decide(input({ files: [docs, code], cfg: { autoApprove: { maxChangedLines: 100 } } }));
  expect(out.reasons).toContain(
    "500 changed lines, 200 counted toward maxChangedLines after excluding 300 inert docs/comment lines (cap 100)",
  );
});

it("an instructions file overrides sizeCapExempt and docs-family: it still counts in full", () => {
  const cfg = { autoApprove: { maxChangedLines: 10, sizeCapExempt: ["**/*"] } };
  const f = fileWithHunks("CLAUDE.md", [hunk(Array(50).fill("+x"))], 50, 0);
  const out = decide(input({ files: [f], cfg }));
  expect(out.reasons).toContain("50 changed lines exceeds autoApprove.maxChangedLines (10)");
});

it("a test file under sizeCapExempt still counts in full", () => {
  const cfg = { autoApprove: { maxChangedLines: 10, sizeCapExempt: ["**/*"] } };
  const f = fileWithHunks("tests/a.test.ts", [hunk(Array(50).fill("+x"))], 50, 0);
  const out = decide(input({ files: [f], cfg }));
  expect(out.reasons).toContain("50 changed lines exceeds autoApprove.maxChangedLines (10)");
});

it("countInertLines: true reproduces today's single-number reason exactly", () => {
  const cfg = { autoApprove: { maxChangedLines: 10, countInertLines: true } };
  const f = fileWithHunks("README.md", [hunk(Array(50).fill("+x"))], 50, 0);
  const out = decide(input({ files: [f], cfg }));
  expect(out.reasons).toContain("50 changed lines exceeds autoApprove.maxChangedLines (10)");
});

it("a comment-only hunk excludes only that hunk; a sibling real-code hunk still counts", () => {
  const f = fileWithHunks(
    "src/a.ts",
    [hunk(Array(300).fill("+// comment")), hunk(Array(150).fill("+const x = 1;"))],
    450,
    0,
  );
  const out = decide(input({ files: [f], cfg: { autoApprove: { maxChangedLines: 400 } } }));
  expect(out.reasons.some((r) => /maxChangedLines/.test(r))).toBe(false); // 150 <= 400
});
```

(`ChangedFile` is already imported at the top of `tests/policy/gate.test.ts`; `hunk`'s return
type needs no new import since it is inferred.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/policy/gate.test.ts`
Expected: FAIL — the size-cap rule still counts every line, so the pure-docs and comment-only
cases wrongly fire, and the two-number reason text does not exist yet.

- [ ] **Step 3: Implement**

In `src/policy/gate.ts`, add to the imports:

```ts
import { countedChangedLines } from "../signals/size.js";
```

Replace rule 2's body:

```ts
  // 2. size cap (a binary file counts as one line; docs, comment-only hunks and configured
  // exemptions do not count toward the cap by default — spec 2026-10-20 §2-§5)
  const cappedFiles = diff.files.filter((f) => !f.ignored);
  const rawLines = cappedFiles.reduce((n, f) => n + (f.binary ? 1 : f.added + f.deleted), 0);
  const counted = countedChangedLines(cappedFiles, config);
  if (counted > auto.maxChangedLines) {
    const reason =
      counted === rawLines
        ? `${rawLines} changed lines exceeds autoApprove.maxChangedLines (${auto.maxChangedLines})`
        : `${rawLines} changed lines, ${counted} counted toward maxChangedLines after excluding ` +
          `${rawLines - counted} inert docs/comment lines (cap ${auto.maxChangedLines})`;
    fire("human-review", reason, "size-cap");
  }
```

This replaces the old `const changedLines = diff.files.filter(...)` local (renamed to
`cappedFiles`/`rawLines` so it no longer shadows the top-level `changedLines` import used by
`contentHits`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/policy/gate.test.ts`
Expected: PASS (including the two pre-existing size-cap tests from before this plan).

- [ ] **Step 5: Run `npx tsc --noEmit`**

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/policy/gate.ts tests/policy/gate.test.ts
git commit -m "feat(policy): size cap excludes inert docs/comment lines by default"
```

---

### Task 4: `contract.instructions` captain fact

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/architecture/contracts.ts`
- Modify: `src/architecture/index.ts`
- Test: `tests/architecture/contracts.test.ts`

**Interfaces:**
- Produces: `ArchitectureFactId` gains `"contract.instructions"`; `detectContracts` emits it;
  `DETECTOR_RANK["contract.instructions"] = 1` (same rank group as the other `contract.*` ids,
  all detected by the `contracts` detector).

- [ ] **Step 1: Write the failing tests**

Add to `tests/architecture/contracts.test.ts`, as a new `describe` block (model it on the
existing `contract.schema` block just above it):

```ts
describe("detectContracts: contract.instructions", () => {
  it("a changed CLAUDE.md is a strong contract.instructions fact", async () => {
    repo = makeRepo();
    const base = repo.commit({ "CLAUDE.md": "rules\n" }, "base");
    repo.commit({ "CLAUDE.md": "rules\nmore\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    const instructionFacts = facts.filter((f) => f.id === "contract.instructions");
    expect(instructionFacts).toHaveLength(1);
    expect(instructionFacts[0]).toMatchObject({ weight: "strong", file: "CLAUDE.md" });
    expect(instructionFacts[0]!.text).toBe("Changes agent instructions: `CLAUDE.md`.");
  });

  it("four instruction files report three facts plus a note counting the rest", async () => {
    repo = makeRepo();
    const base = repo.commit(
      { "CLAUDE.md": "1\n", "AGENTS.md": "1\n", ".cursorrules": "1\n", "a/SKILL.md": "1\n" },
      "base",
    );
    repo.commit({ "CLAUDE.md": "2\n", "AGENTS.md": "2\n", ".cursorrules": "2\n", "a/SKILL.md": "2\n" }, "head");

    const { facts, notes } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.instructions")).toHaveLength(3);
    expect(notes).toContain("1 more instruction file");
  });

  it("a plain .md file that is not on the instructions list is not a contract.instructions fact", async () => {
    repo = makeRepo();
    const base = repo.commit({ "README.md": "1\n" }, "base");
    repo.commit({ "README.md": "2\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.instructions")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/architecture/contracts.test.ts`
Expected: FAIL — `contract.instructions` facts are never produced (and `ArchitectureFactId`
does not have the id yet, so this would also fail to typecheck).

- [ ] **Step 3: Implement**

In `src/domain/types.ts`, add `"contract.instructions"` to `ArchitectureFactId`:

```ts
export type ArchitectureFactId =
  | "coupling.missing"
  | "layers.edge"
  | "layers.cycle"
  | "contract.dependency"
  | "contract.api"
  | "contract.schema"
  | "contract.env"
  | "contract.instructions"
  | "drift.scope";
```

In `src/architecture/index.ts`, add the matching rank entry to `DETECTOR_RANK` (same group as the
other `contract.*` ids, since all are produced by the `contracts` detector):

```ts
const DETECTOR_RANK: Record<ArchitectureFactId, number> = {
  "layers.edge": 0,
  "layers.cycle": 0,
  "contract.dependency": 1,
  "contract.api": 1,
  "contract.schema": 1,
  "contract.env": 1,
  "contract.instructions": 1,
  "coupling.missing": 2,
  "drift.scope": 3,
};
```

In `src/architecture/contracts.ts`, add a constant near `MAX_SCHEMA_FACTS`:

```ts
const MAX_INSTRUCTION_FACTS = 3;
```

And a new block in `detectContracts`, right after the `// contract.schema` block:

```ts
  // contract.instructions
  const instructionFiles = files.filter((f) => matchAny(ctx.config.paths.instructions, f.path, { ignoreCase: true })).map((f) => f.path).sort();
  for (const path of instructionFiles.slice(0, MAX_INSTRUCTION_FACTS)) {
    facts.push({ id: "contract.instructions", weight: "strong", file: path, text: `Changes agent instructions: ${code(path)}.` });
  }
  if (instructionFiles.length > MAX_INSTRUCTION_FACTS) notes.push(plural(instructionFiles.length - MAX_INSTRUCTION_FACTS, "more instruction file"));
```

(`matchAny`, `code`, `plural` are already imported in this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/architecture/contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Run `npx tsc --noEmit`**

Expected: no errors (confirms every other `Record<ArchitectureFactId, ...>` in the codebase —
check with `grep -rn "Record<ArchitectureFactId" src` — got the new key too; `npx tsc --noEmit`
is exhaustive on this, since a `Record` missing a union member is a compile error).

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/architecture/contracts.ts src/architecture/index.ts tests/architecture/contracts.test.ts
git commit -m "feat(captain): contract.instructions fact for changed agent-instruction files"
```

---

### Task 5: `opendrs init` template — `paths.instructions` and a commented `sizeCapExempt` example

**Files:**
- Modify: `src/cli/templates.ts`
- Test: `tests/cli/init-mcp.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_INSTRUCTIONS` (Task 1).
- Produces: `CONFIG_TEMPLATE` still parses to exactly `defaultConfig()`.

- [ ] **Step 1: Write the failing test**

Extend the existing test in `tests/cli/init-mcp.test.ts` (`"lists every default block and
critical glob..."`) to also check `instructions`, and import `DEFAULT_INSTRUCTIONS`:

```ts
import { DEFAULT_BLOCK, DEFAULT_CRITICAL, DEFAULT_INSTRUCTIONS, defaultConfig, parseConfigText } from "../../src/domain/config.js";
```

```ts
  it("lists every default block, critical and instructions glob (user lists extend the defaults, so parsing alone cannot tell)", async () => {
    await runCli(["init"], testIo(repo.dir).io);
    const raw = parse(readFileSync(join(repo.dir, ".opendrs.yml"), "utf8"));
    expect(raw.paths.block).toEqual(DEFAULT_BLOCK);
    expect(raw.paths.critical).toEqual(DEFAULT_CRITICAL);
    expect(raw.paths.instructions).toEqual(DEFAULT_INSTRUCTIONS);
    expect(raw.paths.unblock).toEqual([]);
  });

  it("writes a commented sizeCapExempt example that does not change the parsed defaults", async () => {
    await runCli(["init"], testIo(repo.dir).io);
    const text = readFileSync(join(repo.dir, ".opendrs.yml"), "utf8");
    expect(text).toMatch(/#\s*sizeCapExempt:/);
    expect(parseConfigText(text)).toEqual(defaultConfig());
  });
```

(Rename the existing test, since it already covers block/critical/unblock — do not duplicate it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/init-mcp.test.ts`
Expected: FAIL — `raw.paths.instructions` is `undefined` and no `sizeCapExempt` comment exists.

- [ ] **Step 3: Implement**

In `src/cli/templates.ts`, in `CONFIG_TEMPLATE`'s `paths:` section, add the `instructions` list
right after `tests:` (same literal-array style as `block`, since this field is additive and must
list every `DEFAULT_INSTRUCTIONS` entry exactly, same reasoning as the file header comment
already states for `block`/`critical`):

```
  # Files that steer an AI agent or CI; never excluded from the size cap (see "Inert lines and
  # the size cap" below), whatever their extension. Additive, like block and critical.
  instructions:
    - "**/CLAUDE.md"
    - "**/AGENTS.md"
    - "**/GEMINI.md"
    - ".claude/**"
    - ".cursor/**"
    - ".cursorrules"
    - ".windsurfrules"
    - ".github/copilot-instructions.md"
    - ".github/instructions/**"
    - "**/SKILL.md"
    - "**/*.prompt.md"
    - "**/prompts/**"
    - ".opendrs/**"
```

And in the `autoApprove:` section, right after `maxChangedLines: 400  # never auto-approve above this, whatever the score`:

```
  # countInertLines: true restores pre-0.5 behaviour: every changed line counts, nothing excluded.
  # sizeCapExempt:
  #   - "docs/assets/**"   # e.g. Jekyll/site assets under docs/ are "other", not docs-family,
  #                         # so list them explicitly if you trust them (see docs/configuration.md)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/init-mcp.test.ts`
Expected: PASS

- [ ] **Step 5: Run `npx tsc --noEmit`**

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/templates.ts tests/cli/init-mcp.test.ts
git commit -m "feat(cli): opendrs init template gets paths.instructions and a sizeCapExempt example"
```

---

### Task 6: Docs and CHANGELOG

**Files:**
- Modify: `docs/policy.md`, `docs/auto-approve.md`, `docs/configuration.md`, `docs/captain.md`,
  `CHANGELOG.md`

No new tests — this is prose. Verify by re-reading each page after editing.

- [ ] **Step 1: `docs/policy.md`**

Reword decision rule 3 from:

```
3. more than `maxChangedLines` changed → `human-review`;
```

to:

```
3. more than `maxChangedLines` *counted* lines changed (docs, comment-only hunks and
   `autoApprove.sizeCapExempt` paths do not count by default; see
   [Configuration](configuration.html#inert-lines-and-the-size-cap)) → `human-review`;
```

Add a row to the safety-rail table, after the **Content blocklist** row:

```
| **Agent-instruction files always count.** | `paths.instructions` (by default `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/**`, `.cursor/**`, `SKILL.md`, `*.prompt.md`, `prompts/**`, plus the already-blocked `.github/**`/`.opendrs/**`) is never excluded from the size cap, whatever its extension — additive only, with no `unblock`-style removal. |
```

- [ ] **Step 2: `docs/auto-approve.md`**

In the "What is never auto-approved" list, add a bullet after "PRs that delete tests...":

```
- PRs whose counted size (after excluding inert docs/comment lines) still exceeds `maxChangedLines`,
  and a changed agent-instruction file (`CLAUDE.md`, `.claude/**`, …) always counts in full toward
  that cap;
```

- [ ] **Step 3: `docs/configuration.md`**

In the key table, extend the `paths` row:

```
| `paths` | Blocked, unblocked, critical, instructions, ignored and test globs (see [Why the default block list is long](#why-the-default-block-list-is-long), [Your lists add to the defaults](#your-lists-add-to-the-defaults) and [Inert lines and the size cap](#inert-lines-and-the-size-cap)) |
```

Extend the `autoApprove` row:

```
| `autoApprove` | Whether auto-approval is on, the AI-review checks that must have passed, the merge method, the share of eligible PRs still routed to a human, the changed-lines ceiling and which lines count toward it |
```

In the full-file example's `paths:` block, add `instructions` after `tests`:

```yaml
  instructions: ["**/CLAUDE.md", "**/AGENTS.md", "**/GEMINI.md", ".claude/**", ".cursor/**",
                 ".cursorrules", ".windsurfrules", ".github/copilot-instructions.md",
                 ".github/instructions/**", "**/SKILL.md", "**/*.prompt.md", "**/prompts/**",
                 ".opendrs/**"]
  # ^ never excluded from the size cap; additive like block and critical.
```

In the full-file example's `autoApprove:` block, add after `maxChangedLines`:

```yaml
  sizeCapExempt: []     # never counts toward maxChangedLines, whatever its language family
  countInertLines: false   # true restores pre-0.5 behaviour: every changed line counts
```

Add a new subsection right after "## Why the default block list is long":

```markdown
## Inert lines and the size cap

`autoApprove.maxChangedLines` no longer counts every changed line by default. Blank lines, plain
comments, and whole files in the docs family (`.md`, `.rst`, `.txt`, `.patch`, `.diff`) are
excluded, in this order (first match wins): a `paths.instructions` file always counts in full;
then a `paths.tests` file always counts in full; then a file matching `autoApprove.sizeCapExempt`
never counts; then a docs-family file never counts; then, in any other file, a hunk where every
changed line is blank or a plain comment in that file's own syntax never counts (a sibling
real-code hunk in the same file still does); everything else counts in full. A binary file always
counts as 1. The reason shown when the cap fires names both numbers, e.g. "500 changed lines, 200
counted toward maxChangedLines after excluding 300 inert docs/comment lines (cap 400)".

**Docs folders with executable content are not exempt by default.** A Jekyll layout
(`docs/_layouts/*.html`), a notebook (`.ipynb`), or site JS/CSS under `docs/assets/**` is not
`.md`/`.rst`/`.txt`, so `languageFamily` treats it as `"other"`, not `"docs"` — those lines keep
counting in full unless you explicitly add them to `autoApprove.sizeCapExempt` (e.g.
`sizeCapExempt: ["docs/assets/**"]`) on the default branch, the same trust boundary every other
`.opendrs.yml` setting has. `countInertLines: true` turns this whole feature off and restores the
old, unfiltered count.
```

- [ ] **Step 4: `docs/captain.md`**

Add a `### `contract.instructions`` subsection right after `### `contract.env` — a new
environment variable`, modeled on the existing `### `contract.schema`` subsection:

```markdown
### `contract.instructions` — a changed agent-instruction file

A changed file matched by `paths.instructions` (strong): `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
anything under `.claude/**`/`.cursor/**`, a `SKILL.md`, a `*.prompt.md`, anything under
`prompts/**`, or the already-blocked `.github/**`/`.opendrs/**`. Up to three files, the rest
counted in a note. These files steer what an AI agent or CI does next, so a captain always sees
the change even though it is plain Markdown.
```

- [ ] **Step 5: `CHANGELOG.md`**

Add to the `## Unreleased` section (create `### Added`/`### Changed` entries, or extend the
existing ones if this plan's work lands after the module-boundaries entries are still
unreleased):

```markdown
### Added

- `autoApprove.maxChangedLines` no longer counts every changed line: docs-family files, blank
  lines, plain comments and files matched by the new `autoApprove.sizeCapExempt` no longer count
  toward it by default, so a docs-only or comment-only PR no longer needs a human purely for size.
  New `paths.instructions` (additive, like `paths.block`/`paths.critical`) lists files that steer
  an AI agent or CI — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/**`, `.cursor/**`,
  `SKILL.md`, `*.prompt.md`, `prompts/**`, plus the already-blocked `.github/**`/`.opendrs/**` —
  which always count in full, whatever their extension. A new strong captain fact,
  `contract.instructions`, names a changed instruction file. See
  [docs/specs/2026-10-20-inert-changes-design.md](docs/specs/2026-10-20-inert-changes-design.md).

### Changed

- **Default behaviour change:** before this release, every changed line counted toward
  `autoApprove.maxChangedLines`; now docs and comment-only lines do not, by default
  (`autoApprove.countInertLines: false`). This only loosens the gate — every other rule still runs
  on the full diff — but a repo that relied on the raw line count as a blunt "keep docs PRs small"
  policy will see more PRs pass the cap. Set `autoApprove.countInertLines: true` to restore the
  exact old count.
```

- [ ] **Step 6: Commit**

```bash
git add docs/policy.md docs/auto-approve.md docs/configuration.md docs/captain.md CHANGELOG.md
git commit -m "docs: document inert lines and the size cap, contract.instructions"
```

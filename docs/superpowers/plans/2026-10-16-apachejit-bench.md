# ApacheJIT Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score ApacheJIT's commits with opendrs's real signals and publish AUC, recall@k and F1 next to a Kamei baseline and DRS-OSS.

**Architecture:** Two optional fields on `replayHistory` (`head`, `labels`) let a caller replay an arbitrary labelled commit set. A dev-only `bench/apachejit/` (pure `lib.ts` + `run.ts` entry point over the built `dist/`) downloads the dataset, replays each cloned Apache repo once into a row cache, fits and evaluates, and writes `results.md`.

**Tech Stack:** TypeScript (TS 7, NodeNext, strict, `noUncheckedIndexedAccess`), Node ≥ 23.6 native type stripping for `run.ts`, vitest, git.

**Spec:** `docs/specs/2026-10-16-apachejit-bench-design.md`

## Global Constraints

- Without `labels` and `head`, `replayHistory` behaves byte-for-byte as before; the CLI exposes neither option.
- No change to `src/domain/types.ts`.
- `bench/` is never published (it is not in `package.json` `files`; leave `files` alone).
- `lib.ts` has **no imports at all** (no opendrs, no node built-ins) and uses only erasable TS syntax (no enums, no namespaces, no parameter properties), so Node can strip its types.
- `run.ts` imports opendrs from `../../dist/...js` and `lib` as `./lib.ts`.
- Work dir default `~/.cache/opendrs/apachejit` (outside the repo). Clones are full clones (`--no-checkout`, never `--filter`).
- Dataset hashes (sha256):
  - `apachejit_total.csv` `5097cbbbab8c4611a709b3cf95ac5c9fe5f62e619bab081911a2a247ddbed4e0`
  - `apachejit_train.csv` `7425b77e98ed30270e1d17ce3d179800539cc46a656c927e88e6609cd9b893d2`
  - `apachejit_test_large.csv` `2f21e858026fa625f51f4f6639d845c22c24595e212a3b03d8a5df93bde43ea2`
- Download URL pattern: `https://zenodo.org/records/5907002/files/<file>?download=1`.
- DRS-OSS published numbers: AUC 0.895, F1 0.641, recall@5/10/30 % = 0.315 / 0.503 / 0.864.
- Code style: match the repo (short JSDoc on exported functions, no comment on obvious lines, 2-space, double quotes, max ~150 cols).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. A labelled sha that is abbreviated or upper-case → treated as not found (ApacheJIT uses full lower-case 40-char shas; no fuzzy matching). Test in Task 1.
2. A project whose replay yields zero test positives (`apache/hadoop`) → AUC rendered "—", no crash, no NaN in the pooled tables. Test in Task 2 (`evaluateModel` + `renderReport`).
3. A CSV with Windows line endings or a trailing blank line → parsed identically. Test in Task 2.
4. A truncated / corrupt row-cache line (killed run) → the cache file is discarded and rebuilt, not half-read. Handled in Task 3 (`readCache` returns undefined on any parse error).
5. `fitModel` throwing on a project whose training rows have no positives → that project's calibrated row is `null` with a warning; the run continues. Handled in Task 3.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/model/calibrate.ts` | 1 | `HistoryRunOptions` gains `head?`, `labels?` |
| `src/model/replay.ts` | 1 | honour `head` and `labels` |
| `tests/model/replay.test.ts` | 1 | tests for both options |
| `bench/apachejit/lib.ts` | 2 | parsing, metrics, Kamei features, report rendering (pure) |
| `tests/bench/apachejit-lib.test.ts` | 2 | tests for lib |
| `tsconfig.json` | 2 | `include` adds `bench`, `exclude` `bench/**/run.ts` |
| `bench/tsconfig.json` | 3 | typechecks `run.ts` (noEmit, allowImportingTsExtensions) |
| `bench/apachejit/run.ts` | 3 | download, clone, replay+cache, evaluate, write report |
| `bench/apachejit/README.md` | 3 | how to run |
| `bench/apachejit/results.md`, `docs/calibration.md`, `README.md` | 4 | published results |

Tasks 1, 2 and 3 touch disjoint files and can run in parallel; Task 3 codes against the interfaces below and is integrated after 1 and 2 land. Task 4 needs the full run.

---

### Task 1: `head` and `labels` replay options

**Files:**
- Modify: `src/model/calibrate.ts` (`HistoryRunOptions`, lines 11–19)
- Modify: `src/model/replay.ts` (`replayHistory`)
- Test: `tests/model/replay.test.ts`

**Interfaces:**
- Produces: `HistoryRunOptions.head?: string`, `HistoryRunOptions.labels?: Map<string, 0 | 1>`; `replayHistory` unchanged signature. Not-found warning text exactly: `` `${n} labelled commits not found in the history up to ${head}` `` where `head` is the option value or `"HEAD"`.

- [ ] **Step 1: Write failing tests** (append a `describe("external labels and head", …)` block to `tests/model/replay.test.ts`; use `makeRepo`, `defaultConfig`)

```ts
describe("external labels and head", () => {
  const config = () => defaultConfig();

  it("replays exactly the labelled single-parent commits with the given labels", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const b = repo.commit({ "a.ts": "2\n" }, "edit");
    const c = repo.commit({ "a.ts": "3\n" }, "edit again");
    repo.commit({ "a.ts": "4\n" }, "unlabelled");
    const { rows } = await replayHistory({ repoDir: repo.dir, config: config(), labels: new Map([[b, 1], [c, 0]]) });
    expect(rows.map((r) => [r.sha, r.label]).sort()).toEqual([[b, 1], [c, 0]].sort());
  });

  it("keeps a given 0 label where SZZ-lite would say 1", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "x\n" }, "init");
    const bad = repo.commit({ "a.ts": "x\nbad\n" }, "add bad line");
    repo.commit({ "a.ts": "x\ngood\n" }, "fix bug in bad line");
    const { rows } = await replayHistory({ repoDir: repo.dir, config: config(), labels: new Map([[bad, 0]]) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe(0);
  });

  it("reports unknown, abbreviated and merge shas once as not found", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const b = repo.commit({ "a.ts": "2\n" }, "edit");
    repo.git("checkout", "-q", "-b", "side", "HEAD~1");
    repo.commit({ "s.ts": "s\n" }, "side");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-edit", "side");
    const merge = repo.git("rev-parse", "HEAD");
    const labels = new Map<string, 0 | 1>([[b, 1], ["f".repeat(40), 1], [b.slice(0, 12), 1], [b.toUpperCase(), 1], [merge, 0]]);
    const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: config(), labels });
    expect(rows.map((r) => r.sha)).toEqual([b]);
    expect(warnings).toContain("4 labelled commits not found in the history up to HEAD");
  });

  it("does not apply the label horizon to labelled commits", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const newest = repo.commit({ "a.ts": "2\n" }, "edit");
    const cfg = config();
    cfg.history.labelHorizonDays = 3650;
    const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: cfg, labels: new Map([[newest, 1]]) });
    expect(rows.map((r) => r.sha)).toEqual([newest]);
    expect(warnings.some((w) => w.includes("excluded from evaluation"))).toBe(false);
  });

  it("replays from head: later commits are not replayed and history is cut there", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const b = repo.commit({ "a.ts": "2\n" }, "edit");
    const later = repo.commit({ "a.ts": "3\n" }, "later");
    const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: config(), head: b, labels: new Map([[b, 1], [later, 1]]) });
    expect(rows.map((r) => r.sha)).toEqual([b]);
    expect(warnings).toContain(`1 labelled commits not found in the history up to ${b}`);
  });
});
```

- [ ] **Step 2: Run, expect failures:** `npx vitest run tests/model/replay.test.ts` → the new tests FAIL (unlabelled commits replayed / no warning).

- [ ] **Step 3: Implement.** In `calibrate.ts` add to `HistoryRunOptions`:

```ts
  /** Ref to replay from; also where the import graph is built. Default "HEAD". */
  head?: string;
  /**
   * External labels. When set, exactly these commits are replayed, with these labels: SZZ-lite
   * labelling and the label horizon are skipped. `since` and `maxCommits` still bound the walk.
   */
  labels?: Map<string, 0 | 1>;
```

In `replay.ts`, `replayHistory`:
- `const head = (await git(repoDir, ["rev-parse", "--verify", "--end-of-options", `${opts.head ?? "HEAD"}^{commit}`])).trim();`
- after the `since`/`maxCommits` filtering, branch:

```ts
  const warnings: string[] = [];
  let labels: Map<string, 0 | 1>;
  if (opts.labels) {
    const given = opts.labels;
    const found = commits.filter((c) => given.has(c.sha));
    const missing = given.size - found.length;
    if (missing > 0) warnings.push(`${missing} labelled commits not found in the history up to ${opts.head ?? "HEAD"}`);
    commits = found;
    labels = given;
  } else {
    // existing label-horizon block, unchanged
    ...
    const labelled = await labelCommits(repoDir, history, config, await loadIncidents(repoDir), (w) => warnings.push(w));
    labels = new Map(labelled.map((l) => [l.sha, l.label]));
  }
```

Keep the existing horizon comment and code verbatim inside the `else`. The row mapper keeps `labels.get(c.sha) ?? 0`.

- [ ] **Step 4: Run** `npx vitest run tests/model/` → all PASS (old tests unchanged). Then `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/model/calibrate.ts src/model/replay.ts tests/model/replay.test.ts
git commit -m "feat(replay): external labels and a replay head for benchmarks"
```

---

### Task 2: `bench/apachejit/lib.ts`

**Files:**
- Create: `bench/apachejit/lib.ts`
- Create: `tests/bench/apachejit-lib.test.ts`
- Modify: `tsconfig.json` → `"include": ["src", "tests", "bench"], "exclude": ["bench/**/run.ts"]`

**Interfaces (Produces — Task 3 uses exactly these):**

```ts
export const KAMEI_IDS = ["la", "ld", "nf", "nd", "ns", "ent", "ndev", "age", "nuc", "aexp", "arexp", "asexp"] as const;
export type KameiId = (typeof KAMEI_IDS)[number];
export interface JitRow { sha: string; project: string; buggy: 0 | 1; time: number; kamei: Record<KameiId, number> }
export type Split = "total" | "train" | "test_large";
export interface DatasetFile { split: Split; file: string; url: string; sha256: string }
export const DATASET: DatasetFile[];                 // the three files in Global Constraints
export interface Project { project: string; name: string; url: string } // "apache/zookeeper", "zookeeper", "https://github.com/apache/zookeeper.git"
export const PROJECTS: Project[];                    // all 15, sorted by name
export function parseApacheJit(text: string): JitRow[];
export function aucOf(scores: number[], labels: number[]): number | null;   // null when a class is absent
export function recallAt(scores: number[], labels: number[], pct: number): number;
export interface Prf { precision: number; recall: number; f1: number }
export function bestF1Threshold(scores: number[], labels: number[]): number;
export function f1At(scores: number[], labels: number[], threshold: number): Prf;
export function kameiFeatures(row: JitRow): number[];  // KAMEI_IDS order; log1p for all but "ent"
export const RECALL_KS = ["5", "10", "30", "50"] as const;
export interface ModelMetrics { rows: number; positives: number; auc: number | null; recallAt: Record<(typeof RECALL_KS)[number], number>; prf: Prf }
export function evaluateModel(train: { scores: number[]; labels: number[] }, test: { scores: number[]; labels: number[] }): ModelMetrics;
export type ModelName = "default" | "calibrated" | "kamei" | "kameiReplayed";
export const MODEL_LABELS: Record<ModelName, string>; // "opendrs, default priors", "opendrs, calibrated", "Kamei LR (all CSV rows)", "Kamei LR (replayed rows)"
export interface Coverage { labelled: number; replayed: number }
export interface ProjectResult {
  project: string;            // "apache/zookeeper" or "pooled" / "pooled (excluding apache/hadoop)"
  head?: string;
  coverage: { train: Coverage; test: Coverage };
  models: Partial<Record<ModelName, ModelMetrics | null>>; // null = could not fit
  calibration?: "fitted" | "priors";
  skipped?: string;           // reason the project was skipped
  warnings: string[];
}
export interface Report {
  meta: { version: string; commit: string; date: string; hashes: Record<string, string> };
  pooled: ProjectResult[];    // [all, excluding apache/hadoop]
  projects: ProjectResult[];
}
export const DRS_OSS: { auc: number; f1: number; recallAt: { "5": number; "10": number; "30": number } };
export const CAVEATS: string[];   // spec §5 bullets, verbatim
export function renderReport(report: Report): string;
```

- [ ] **Step 1: Write failing tests** in `tests/bench/apachejit-lib.test.ts` (import from `"../../bench/apachejit/lib.js"`, plus `capturedAt` from `"../../src/model/metrics.js"` and `mulberry32` from `"../../src/model/fit.js"` for the cross-check):

```ts
const HEADER = "commit_id,project,buggy,fix,year,author_date,la,ld,nf,nd,ns,ent,ndev,age,nuc,aexp,arexp,asexp";
const ROW = (sha: string, buggy: string) => `${sha},apache/zookeeper,${buggy},False,2017,1500000000,10,2,3,2,1,0.5,4,30.5,6,100,50,20`;
const SHA = "a".repeat(40);

describe("parseApacheJit", () => {
  it("parses rows and maps True/False", () => {
    const [r] = parseApacheJit(`${HEADER}\n${ROW(SHA, "True")}\n`);
    expect(r).toEqual({ sha: SHA, project: "apache/zookeeper", buggy: 1, time: 1500000000,
      kamei: { la: 10, ld: 2, nf: 3, nd: 2, ns: 1, ent: 0.5, ndev: 4, age: 30.5, nuc: 6, aexp: 100, arexp: 50, asexp: 20 } });
  });
  it("accepts CRLF and a trailing blank line", () => {
    expect(parseApacheJit(`${HEADER}\r\n${ROW(SHA, "False")}\r\n\r\n`)).toHaveLength(1);
  });
  it("rejects a wrong header", () => expect(() => parseApacheJit("sha,label\n")).toThrow(/header/));
  it("rejects a malformed row with its line number", () => {
    expect(() => parseApacheJit(`${HEADER}\n${ROW(SHA, "True")}\n${SHA},apache/x,maybe\n`)).toThrow(/line 3/);
  });
});

describe("metrics", () => {
  it("recallAt agrees with opendrs capturedAt, ties included", () => {
    const rand = mulberry32(7);
    const scores = Array.from({ length: 500 }, () => Math.round(rand() * 20) / 20);
    const labels = scores.map(() => (rand() < 0.2 ? 1 : 0));
    for (const k of [5, 10, 30, 50]) expect(recallAt(scores, labels, k)).toBeCloseTo(capturedAt(scores, labels, k), 12);
  });
  it("aucOf is null when a class is absent and 1 for a perfect ranking", () => {
    expect(aucOf([0.1, 0.2], [0, 0])).toBeNull();
    expect(aucOf([0.1, 0.9], [0, 1])).toBe(1);
  });
  it("bestF1Threshold and f1At", () => {
    const scores = [0.9, 0.8, 0.3, 0.1];
    const labels = [1, 1, 0, 0];
    const t = bestF1Threshold(scores, labels);
    expect(f1At(scores, labels, t)).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(f1At(scores, [0, 0, 0, 0], 0.5)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
  it("evaluateModel on a test set without positives has null AUC and zero recall", () => {
    const m = evaluateModel({ scores: [0.9, 0.1], labels: [1, 0] }, { scores: [0.5, 0.4], labels: [0, 0] });
    expect(m.auc).toBeNull();
    expect(m.recallAt["10"]).toBe(0);
    expect(m.positives).toBe(0);
  });
});

it("kameiFeatures applies log1p to counts and leaves ent raw", () => {
  const [r] = parseApacheJit(`${HEADER}\n${ROW(SHA, "True")}\n`);
  const f = kameiFeatures(r!);
  expect(f[KAMEI_IDS.indexOf("la")]).toBeCloseTo(Math.log1p(10));
  expect(f[KAMEI_IDS.indexOf("ent")]).toBe(0.5);
});

it("renderReport shows — for an undefined AUC and includes the caveats", () => {
  const empty = { rows: 2, positives: 0, auc: null, recallAt: { "5": 0, "10": 0, "30": 0, "50": 0 }, prf: { precision: 0, recall: 0, f1: 0 } };
  const md = renderReport({
    meta: { version: "0.1.5", commit: "abc", date: "2026-10-16", hashes: { "apachejit_train.csv": "x" } },
    pooled: [],
    projects: [{ project: "apache/hadoop", coverage: { train: { labelled: 1, replayed: 1 }, test: { labelled: 2, replayed: 2 } }, models: { default: empty }, warnings: [] }],
  });
  expect(md).toContain("—");
  for (const c of CAVEATS) expect(md).toContain(c);
  expect(md).not.toContain("NaN");
});
```

- [ ] **Step 2: Run** `npx vitest run tests/bench` → FAIL (module missing).

- [ ] **Step 3: Implement `lib.ts`.** Requirements per function:
  - `parseApacheJit`: split on `/\r?\n/`, drop trailing empty lines; first line must equal the exact header else throw `Error("ApacheJIT header mismatch: …")`; each row must have 18 fields, a 40-hex lower-case sha, `buggy` ∈ {`True`,`False`}, finite numbers for `author_date` and the 12 Kamei columns, else throw `Error(\`ApacheJIT line ${n}: …\`)` (1-based line numbers, header is line 1).
  - `aucOf`: Mann–Whitney with average ranks for ties (same algorithm as `src/model/metrics.ts` `auc`), `null` if either class is absent.
  - `recallAt`: same algorithm as `capturedAt` in `src/model/metrics.ts` (copy it; tie group straddling the cut credited by expected share); 0 when no positives.
  - `bestF1Threshold`: candidate thresholds = distinct scores; predicted positive iff `score >= t`; return the candidate with the highest F1, ties → the higher threshold; with no positives return `Infinity`.
  - `f1At`: precision = tp/(tp+fp) (0 if none predicted), recall = tp/(tp+fn) (0 if no positives), f1 = harmonic mean (0 if both 0).
  - `evaluateModel`: threshold from `bestF1Threshold(train)`, `prf` = `f1At(test, threshold)`, `recallAt` for each of `RECALL_KS`, `auc = aucOf(test)`.
  - `renderReport`: Markdown with sections `# opendrs on ApacheJIT`, a metadata list (version, commit, date, each dataset hash), `## Pooled` (one table per pooled result), `## Per project` (one table: project, head (12 chars), train replayed/labelled, test replayed/labelled, then per model AUC and recall@10 %), `## Caveats` (each `CAVEATS` entry as a bullet), `## Warnings` (per project, skipped reasons included). Each model table row: model label, rows, positives, AUC, recall@5/10/30/50 %, precision, recall, F1. A DRS-OSS row (from `DRS_OSS`, "—" where not published) follows each pooled table. Format: AUC and F1 with 3 decimals, recall as `xx.x %`; `null` / missing → `—`; never print `NaN`.
  - `CAVEATS`: one string per spec §5 bullet (bold lead-in included, as in the spec).

- [ ] **Step 4: Run** `npx vitest run tests/bench && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add bench/apachejit/lib.ts tests/bench/apachejit-lib.test.ts tsconfig.json
git commit -m "feat(bench): ApacheJIT parsing, metrics and report rendering"
```

---

### Task 3: `bench/apachejit/run.ts`

**Files:**
- Create: `bench/tsconfig.json`, `bench/apachejit/run.ts`, `bench/apachejit/README.md`

**Interfaces:**
- Consumes (from `dist/` after `npm run build`): `replayHistory` (`dist/model/replay.js`, options incl. `head`, `labels` from Task 1), `fitModel` (`dist/model/calibrate.js`), `fitLogistic` (`dist/model/fit.js`), `scoreSignals` (`dist/model/logistic.js`), `DEFAULT_WEIGHTS` (`dist/model/defaults.js`), `defaultConfig` (`dist/domain/config.js`), `VERSION` (`dist/version.js`), types from `dist/domain/types.js`. Everything in Task 2's interface block from `./lib.ts`.

`bench/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "noEmit": true, "allowImportingTsExtensions": true, "rootDir": ".." },
  "include": ["apachejit/**/*.ts"],
  "exclude": []
}
```

- [ ] **Step 1: Write `run.ts`.** Structure (each a small function):
  1. `parseArgs` (node:util): `--work-dir` (default `join(homedir(), ".cache/opendrs/apachejit")`), `--projects` (comma list of short names, validated against `PROJECTS`, unknown → exit 2 with the valid list), `--max-per-project` (positive int), `--concurrency` (default 2), `--out` (default `bench/apachejit/results.md`).
  2. `ensureDataset(dir)`: for each `DATASET` entry, download with `fetch` to `<dir>/data/<file>` if absent; compute sha256 (`node:crypto`); mismatch → throw `Error(\`${file}: sha256 ${got}, expected ${sha256}\`)`. Return parsed rows per split.
  3. `ensureClone(dir, project)`: `<dir>/repos/<name>`; if absent `git clone -q --no-checkout <url> <path>` (`execFile`, promisified). Then `head = git rev-list -1 --before=2020-01-01 HEAD`; empty → skip project with reason.
  4. Labels per project: from `train` and `test_large` rows of that project; with `--max-per-project n`, keep the newest `n` per split (by `time`). `labels = new Map(sha → buggy)`.
  5. Cache: `<dir>/rows/<name>.<VERSION>.jsonl`; each line `{"sha","time","label","signals":[{"id","value","status"}]}`. `readCache(path)` returns `ReplayRow[] | undefined` — undefined if absent or **any** line fails `JSON.parse` (then delete the file). Cached rows must cover the requested labels (if a sha set differs, e.g. a different `--max-per-project`, re-replay). On miss: `replayHistory({ repoDir, config, head, labels, onProgress })` with `config = defaultConfig(); config.history.maxCommits = 1_000_000;`; write the cache (summary `""`, evidence `[]` when rehydrating to satisfy `Signal`).
  6. `evaluateProject(rows, jit)`: split replayed rows by membership in the project's train vs test sha sets. Models:
     - `default`: `scoreSignals(r.signals, DEFAULT_WEIGHTS).score` for train and test.
     - `calibrated`: `fitModel(trainRows, DEFAULT_WEIGHTS, name)` in try/catch → on error `null` and push the message to warnings; record `calibration = model.calibration?.chosen ?? "fitted"`.
     - `kamei`: `fitLogistic(train.map(kameiFeatures), train.map(buggy), { l2: 0.01 })` over **all** CSV train rows; score test rows with `sigmoid(intercept + w·x)` (inline the sigmoid; 3 lines).
     - `kameiReplayed`: the same Kamei model scored only on the test rows that were replayed (train threshold from replayed train rows).
     - each via `evaluateModel`.
  7. Pooled: concatenate all projects' rows (and JIT rows) → one `fitModel` / Kamei fit / evaluation; again excluding `apache/hadoop`.
  8. Concurrency: process projects with a simple pool of `--concurrency` workers; progress to stderr as `<name>: done/total`.
  9. `meta`: `VERSION`, `git rev-parse --short HEAD` of the opendrs checkout, `new Date().toISOString().slice(0,10)`, dataset hashes. Write `renderReport` to `--out`, print the pooled section to stdout. Exit 1 if any project was skipped, else 0.

- [ ] **Step 2: Typecheck:** `npm run build && npx tsc -p bench` → no errors.

- [ ] **Step 3: Smoke run:** `node bench/apachejit/run.ts --projects zookeeper,groovy --max-per-project 300 --out /tmp/apachejit-smoke.md` → exits 0, report has two project rows, AUCs are numbers, no `NaN`. Run it a second time → finishes in seconds (cache hit) with an identical report apart from nothing (date same day).

- [ ] **Step 4: Write `bench/apachejit/README.md`:** prerequisites (Node ≥ 23.6, git, ~15 GB disk), `npm run build`, the command and flags, where things are written, expected run time, that `results.md` is generated, and a pointer to the spec for caveats.

- [ ] **Step 5: Commit**

```bash
git add bench/tsconfig.json bench/apachejit/run.ts bench/apachejit/README.md
git commit -m "feat(bench): ApacheJIT benchmark runner"
```

---

### Task 4: Full run and published results

**Files:** `bench/apachejit/results.md` (generated), `docs/calibration.md`, `README.md`

- [ ] **Step 1:** `npm run build && node bench/apachejit/run.ts --concurrency 4` (background; clones already in the work dir).
- [ ] **Step 2:** Read `results.md`. Sanity: pooled AUC between 0.5 and 1; coverage replayed/labelled ≥ 90 % per project, else investigate the not-found warnings before publishing.
- [ ] **Step 3:** Add `## Results on ApacheJIT` to `docs/calibration.md` (before "Reading the metrics"): the pooled table (excluding hadoop and all), three interpretation bullets grounded only in the numbers, a link to `../bench/apachejit/results.md`. In `README.md` under "Results on public repositories", one sentence linking to it.
- [ ] **Step 4:** `npm run check` → PASS. Commit:

```bash
git add bench/apachejit/results.md docs/calibration.md README.md
git commit -m "docs: publish opendrs results on ApacheJIT"
```

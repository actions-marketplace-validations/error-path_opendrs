# ApacheJIT benchmark

Status: design approved 2026-10-16; spec awaiting review.

## 1. Goal

Put opendrs on the same axis as the just-in-time (JIT) defect-prediction literature and DRS-OSS by
scoring the commits of ApacheJIT (Keshavarz and Nagappan, MSR 2022, arXiv 2203.00101) with
opendrs's real signals, and publishing the numbers.

The benchmark measures **exactly what `opendrs calibrate` produces**, on commits labelled by someone
else, with a held-out test set chosen by someone else. It also becomes the yardstick for later
changes (the structured LLM judge, new signals): a change that does not move these numbers did not
improve ranking.

Success criteria:

1. `npm run check` passes, with tests for the new replay options and the benchmark's pure helpers.
2. A smoke run (`--projects zookeeper,groovy`) completes end to end on a clean machine.
3. A full run over all 15 project values completes on the maintainer's machine, and its report is
   committed as `bench/apachejit/results.md` with a short summary in `docs/calibration.md`.

Non-goals: a public CLI flag for external labels (`.opendrs/incidents.jsonl` covers user labels);
reproducing DRS-OSS's own split (only if its replication package publishes split files); scoring
the LLM signal in the benchmark; implementing deep-learning JIT baselines.

## 2. The dataset

Source: Zenodo record 5907002 (DOI 10.5281/zenodo.5907002), licence CC-BY-4.0. Mirror:
`github.com/hosseinkshvrz/apachejit`, `dataset/`.

| File | Rows | Buggy | Years |
|---|---:|---:|---|
| `apachejit_total.csv` | 106,674 | 28,239 | 2003–2019 |
| `apachejit_train.csv` | 44,834 | 22,421 | 2003–2016 |
| `apachejit_test_large.csv` | 30,111 | 5,818 | 2017–2019 |
| `apachejit_test_small.csv` | 7,526 | 1,448 | 2017–2019 |

Full hashes (pinned in `lib.ts`, checked after download):

```
5097cbbbab8c4611a709b3cf95ac5c9fe5f62e619bab081911a2a247ddbed4e0  apachejit_total.csv
7425b77e98ed30270e1d17ce3d179800539cc46a656c927e88e6609cd9b893d2  apachejit_train.csv
2f21e858026fa625f51f4f6639d845c22c24595e212a3b03d8a5df93bde43ea2  apachejit_test_large.csv
```

Header: `commit_id,project,buggy,fix,year,author_date,la,ld,nf,nd,ns,ent,ndev,age,nuc,aexp,arexp,asexp`.
`buggy` and `fix` are the strings `True`/`False`; `author_date` is Unix seconds; `project` is
`apache/<name>`. The CSVs hold no diffs or messages, so scoring opendrs's signals requires clones.

Facts the design depends on:

- **The official split is by year.** `train` is 2003–2016 and balanced 50/50 by the dataset authors;
  `test_large` is 2017–2019 at its real ~19 % positive rate. `test_small` is a subset of
  `test_large` and is not used.
- **15 project values, not 14.** `apache/hadoop`, `apache/hadoop-hdfs` and `apache/hadoop-mapreduce`
  are separate values. The last two are separate archived GitHub mirrors, so each value is its own
  clone (`https://github.com/<project>.git`).
- **`apache/hadoop` has no positive rows** (11,964 rows, 0 buggy; 5,421 of them in `test_large`).
  Pooled numbers are reported both with and without it; its per-project AUC is undefined and shown
  as "—".
- Labels come from a modified B-SZZ with JIRA links: fix commits are identified by issue tracker,
  not by commit message. They are independent of opendrs's own revert/SZZ-lite labels.

## 3. Product change: two replay options

The only change to `src/`. `HistoryRunOptions` (`src/model/calibrate.ts`) gains two optional
fields, read by `replayHistory` (`src/model/replay.ts`):

```ts
/** Ref to replay from; also where the import graph is built. Default "HEAD". */
head?: string;
/**
 * External labels. When set, exactly these commits are replayed, with these labels:
 * SZZ-lite labelling and the label horizon are skipped. `since` and `maxCommits` still bound
 * the walk.
 */
labels?: Map<string, 0 | 1>;
```

Behaviour with `labels` set:

- Commits are the history index's single-parent commits whose sha is a key of `labels`. A key not
  found among them (unknown sha, a merge commit, or beyond `history.maxCommits`) is counted, and
  one warning reports the count: "`n` labelled commits not found in the history up to `<head>`".
- `labelCommits` and `loadIncidents` are not called: the labels are given, and blaming every fix
  commit of a large repository would dominate the run time.
- The label horizon is not applied: the dataset's labels are as mature as they will get.
- Everything else is unchanged: point-in-time signals per commit, the shared import graph (now built
  at `head`), the skipped-commit count.

Without `labels` and `head`, behaviour is byte-for-byte what it is today. The CLI does not expose
either option.

`label: 0 | 1` on `ReplayRow` keeps its meaning. No change to `types.ts`, so the shared-contract rule
in its header does not apply.

## 4. The benchmark: `bench/apachejit/`

Dev-only. `bench/` is not in `package.json` `files`, so it is never published.

```
bench/
  tsconfig.json          extends the root; typechecks bench/ against the built dist/
  apachejit/
    README.md            how to run, disk and time needed, caveats
    lib.ts               pure helpers, no opendrs imports (unit-tested)
    run.ts               entry point (Node ≥ 23.6 native type stripping), imports ../../dist/
    results.md           committed output of the full run
tests/bench/
  apachejit-lib.test.ts  vitest tests for lib.ts
```

`run.ts` imports the built library (`../../dist/…`), because `src/` uses `.js` import specifiers
that native type stripping cannot map back to `.ts`. The README says to run `npm run build` first.
The root `npm run check` covers `lib.ts` through its tests (the root `tsconfig.json` adds `bench` to
`include`, excluding `run.ts`); `run.ts` is checked by `npx tsc -p bench` after a build.

### 4.1 `lib.ts`

- `parseApacheJit(text): JitRow[]`, where `JitRow = { sha, project, buggy: 0 | 1, time, kamei: Record<KameiId, number> }`.
  Strict: the exact header is required, and a malformed row throws with its line number.
- `PROJECTS`: the 15 project values with their clone URLs.
- `DATASET`: file names, Zenodo download URLs and the sha256 hashes in §2.
- `recallAt(scores, labels, pct)`: the share of positives in the riskiest `pct` %, with ties
  credited by expected share. It is the same definition as opendrs's `capturedAt`, duplicated here
  so `lib.ts` stays free of opendrs imports, and a test asserts the two agree on random input.
- `bestF1Threshold(scores, labels)`: the score threshold that maximizes F1 on the given rows.
- `f1At(scores, labels, threshold)`: `{ precision, recall, f1 }` with `score ≥ threshold` predicted
  positive.
- `kameiFeatures(row)`: `log1p` of `la, ld, nf, nd, ns, ndev, age, nuc, aexp, arexp, asexp` plus raw
  `ent`. This is the classic Kamei et al. feature set, used for the baseline in §4.3.
- `renderReport(results): string`: the Markdown in §4.4.

### 4.2 `run.ts`

```
node bench/apachejit/run.ts [--work-dir <dir>] [--projects a,b] [--max-per-project <n>]
                            [--concurrency <n>] [--out <file>]
```

- `--work-dir`: where the CSVs, clones and the row cache live. Default `~/.cache/opendrs/apachejit`.
  It is outside the repository, so the 10–15 GB of clones never land in a checkout or a worktree.
- `--projects`: short names (`zookeeper`, `hadoop-hdfs`), default all 15.
- `--max-per-project`: cap the labelled commits per project and split (newest first) for smoke runs.
- `--concurrency`: projects replayed at once (default 2). Each replay already runs 8 commits in parallel.
- `--out`: the report path, default `bench/apachejit/results.md`.

Steps:

1. **Dataset.** Download `total`, `train` and `test_large` into `<work-dir>/data` if absent, then
   verify each sha256. A mismatch stops the run.
2. **Clones.** For each project, `git clone --no-checkout <url>` into `<work-dir>/repos/<name>` if
   absent. It is a full clone: a partial (`--filter=blob:none`) clone would fetch blobs lazily
   while opendrs reads file contents, one network round trip per file.
3. **Head.** A pinned sha per project (`PROJECTS[].head`): the default branch at the dataset's end.
   A date cutoff is not reproducible (`git rev-list --before=<date>` fills in the current time of
   day), so the shas are fixed. Most are the last 2019 commit; camel, groovy, hadoop and kafka are
   commits of 1 January 2020 (UTC), which only moves the import-graph approximation by hours. The
   import graph is built there, not at today's tip.
4. **Replay.** The config is `defaultConfig()` with `history.maxCommits` raised to 1,000,000 and
   `labelHorizonDays` irrelevant (labels are external). `replayHistory({ repoDir, config, head, labels })`
   runs with `labels` covering the project's `train` and `test_large` rows. The rows go to
   `<work-dir>/rows/<project>.<opendrs version>.jsonl`, one row per line, keeping each signal's
   `{id, value, status}` only (no summary or evidence). An existing cache file for the same version
   is reused, so re-fitting after a change to `lib.ts` takes seconds. Replay warnings, including the
   not-found count, go into the report.
5. **Evaluate.** For each project, and pooled over all projects with and without `apache/hadoop`:
   - **opendrs default priors:** `scoreSignals(signals, DEFAULT_WEIGHTS)` on the test rows.
   - **opendrs calibrated:** `fitModel(trainRows, DEFAULT_WEIGHTS)` exactly as `calibrate` runs it,
     including its inner 80/20 time split, L2 choice, 5:1 resample and keep-the-priors check,
     scored on the test rows. The report records whether the fit or the priors were kept.
   - **Kamei LR baseline:** `fitLogistic` on `kameiFeatures` of the same train rows (L2 0.01, no
     priors), scored on the same test rows. It needs no clone, so it covers every test row, and it is
     also reported restricted to the replayed rows so the comparison is like for like.

   For each model: AUC, recall at 5 / 10 / 30 / 50 % gated, and precision, recall and F1 at the
   threshold `bestF1Threshold` picks on that model's **training** scores, with negatives weighted to
   the projects' real pre-2017 positive rate. The test set never chooses a threshold. Recall and F1
   are "—" when the test rows have no positives.
6. **Report.** Write `--out` (§4.4) and print the pooled table.

Determinism: the pinned dataset, a fixed head per project, opendrs's deterministic fit and
resampling, and no wall-clock reads in the evaluation. Two runs on the same version produce the same
report.

### 4.3 What is compared

| Row | What it shows |
|---|---|
| opendrs, default priors | the zero-config score a new user gets |
| opendrs, calibrated | what `opendrs calibrate` gives on this history |
| Kamei LR (CSV metrics) | whether opendrs's signals beat the classic JIT metrics on the same commits |
| DRS-OSS (published) | AUC 0.895, F1 0.641, recall@5/10/30 % = 0.315 / 0.503 / 0.864, quoted from arXiv 2511.21964 |

### 4.4 Report contents

`results.md` holds:

- the run's metadata: opendrs version and commit, date, dataset hashes, the head sha per project;
- coverage: labelled rows, replayed rows and not-found rows per project and split;
- the pooled table (all projects, and excluding `apache/hadoop`) and the per-project table;
- the caveats in §5, verbatim.

`docs/calibration.md` gets a short "Results on ApacheJIT" section: the pooled table, three bullet
points of interpretation, and a link to `bench/apachejit/results.md`. README links to it from
"Results on public repositories".

## 5. Caveats the report states

- **Different split from DRS-OSS.** DRS-OSS used its own chronological 80/10/10 split and reads
  diffs and messages with a fine-tuned LLM. Its numbers are a reference, not a like-for-like
  comparison.
- **Graph approximation.** The import graph is built once per project at the end of 2019, so a 2010
  commit sees 2019 dependents. This is the same approximation `backtest` already reports.
- **Labels are SZZ with JIRA links.** They are noisy in the ways SZZ is noisy (reformatting, wide
  fixes), and they differ from opendrs's own labels.
- **Java-only.** ApacheJIT exercises the language-agnostic signals and the Java import extractor,
  not the other languages' extractors.
- **`apache/hadoop` has no positives**, hence the pooled table with and without it.
- **Balanced training file.** `train` is undersampled to about 50/50 overall (from 5 % to 85 %
  positive per project), so `fitModel`'s 5:1 resample keeps every row and its prior correction
  centres scores on the training file's rate, not the real one. AUC and recall@k do not depend on
  that, but F1 does. The F1 threshold is therefore chosen on training scores with each negative
  weighted so the training set has the real pre-2017 positive rate of the same projects (from
  `apachejit_total.csv`); test rows never choose it.

## 6. Error handling

- A failed download or hash mismatch stops the run with the file name and expected hash.
- A failed clone, or a pinned head missing from the clone, skips that project, records it
  in the report, and the run continues. The exit code is 1 if any project was skipped.
- Replay errors on single commits are already counted as skipped by `replayHistory`.
- A cache file that fails to parse is deleted and rebuilt.

## 7. Testing

`tests/model/replay.test.ts` (with `makeRepo`):

- with `labels`, exactly the labelled single-parent commits are replayed, carrying the given labels;
  an unlabelled commit is absent from the rows;
- a commit that SZZ-lite would label positive keeps its given label 0 (labelling is skipped);
- a labelled sha that is a merge commit, or unknown, is reported once in the not-found warning count;
- the label horizon is not applied: a labelled commit newer than the horizon is replayed;
- `head` set to an older commit: commits after it are not replayed, and history is cut there;
- without either option, the existing tests pass unchanged.

`tests/bench/apachejit-lib.test.ts`:

- `parseApacheJit` reads a fixture of a few rows, maps `True`/`False`, and rejects a wrong header
  and a malformed row with its line number;
- `recallAt` agrees with opendrs's `capturedAt` on seeded random scores, ties included;
- `bestF1Threshold` and `f1At` on hand-checked small cases (all-positive, all-negative, ties);
- `kameiFeatures` applies `log1p` to the counts and leaves `ent` raw;
- `renderReport` shows "—" for an undefined AUC and includes the caveats.

The download, clone and full run are not unit-tested; the smoke run (success criterion 2) covers them.

## 8. Effort and run cost

- Code: the replay options (about 30 lines plus tests), `lib.ts` (about 150), `run.ts` (about 200), docs.
- Full run: about 10–15 GB of clones; an estimated 3–8 hours of replay on 16 cores, extrapolated
  from the 1–16 minutes per 4,000 commits measured in earlier backtests. The row cache makes every
  later evaluation take seconds.

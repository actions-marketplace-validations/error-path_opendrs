# ApacheJIT benchmark

Scores the commits of [ApacheJIT](https://doi.org/10.5281/zenodo.5907002) (Keshavarz and Nagappan,
MSR 2022) with opendrs's real signals and compares four models on the dataset's own year split
(`train` 2003–2016, `test_large` 2017–2019): opendrs with default priors, opendrs calibrated
exactly as `opendrs calibrate` fits, and a Kamei logistic regression on the dataset's metrics (on all
rows, and on the replayed rows only). The report also quotes DRS-OSS's published numbers.

The design, the metrics and the caveats are in
[`docs/specs/2026-10-16-apachejit-bench-design.md`](../../docs/specs/2026-10-16-apachejit-bench-design.md).

## Prerequisites

- Node ≥ 23.6 (`run.ts` runs with native type stripping) and git.
- About 15 GB of free disk for the 15 full clones.
- A build of opendrs: `run.ts` imports `dist/`, so run `npm run build` first, and again after any
  change to `src/`.

## Running

From the repository root:

```sh
npm run build
node bench/apachejit/run.ts                                                  # all 15 projects
node bench/apachejit/run.ts --projects zookeeper,groovy --max-per-project 300  # smoke run
```

| Flag | Default | Meaning |
|---|---|---|
| `--work-dir <dir>` | `~/.cache/opendrs/apachejit` | where the CSVs, clones and row cache live |
| `--projects a,b` | all 15 | short project names, e.g. `zookeeper`, `hadoop-hdfs` |
| `--max-per-project <n>` | none | keep the newest `n` labelled commits per project and split |
| `--concurrency <n>` | 2 | projects replayed at once (each replay runs 8 commits in parallel) |
| `--out <file>` | `bench/apachejit/results.md` | the report |

The pooled table is also printed to stdout; progress goes to stderr. The exit code is 1 when a
project was skipped (failed clone, or its pinned head is missing from the clone), 2 on a bad flag.

## What it writes

Under the work dir, outside the repository:

- `data/`: the three CSVs, downloaded from Zenodo when absent and checked against pinned sha256 hashes.
- `repos/<name>`: full `--no-checkout` clones. An existing directory is used as is.
- `rows/<name>.<opendrs version>.jsonl`: the replayed rows (`.max<n>` is added for capped runs). A
  file is reused while the version, the replay head and the labelled commits match, so re-fitting
  after a change to `lib.ts` takes seconds. A file that fails to parse is deleted and rebuilt.

`results.md` is generated: do not edit it by hand, rerun the benchmark.

## LLM judge benchmark

`llm.ts` measures the structured LLM judge
([`docs/specs/2026-10-16-structured-llm-judge-design.md`](../../docs/specs/2026-10-16-structured-llm-judge-design.md))
on a seeded sample of the replayed commits (`mulberry32(1)`, `apache/hadoop` excluded): it judges
each sampled commit's diff with an Anthropic model, then reports AUC/recall with and without the
`llm.*` signals (default priors and calibrated on the train sample), the Kamei LR on the same
sample, how many test commits the `llm.requireSafe` gate would pass at confidence 8, 6 and 9 with
their buggy rate against the sample's base rate, and per risk category the commits it flagged.

It needs the row cache and clones of a full `run.ts` run, a current build, and `ANTHROPIC_API_KEY`
(read by `createLlmProvider`, never printed).

```sh
npm run build
ANTHROPIC_API_KEY=... node bench/apachejit/llm.ts
```

| Flag | Default | Meaning |
|---|---|---|
| `--work-dir <dir>` | `~/.cache/opendrs/apachejit` | the same work dir as `run.ts` |
| `--model <id>` | `claude-fable-5-1` | Anthropic model id |
| `--train <n>` / `--test <n>` | 1500 / 1500 | sample sizes from the `train` and `test_large` rows |
| `--concurrency <n>` | 16 | judgements in flight |
| `--out <file>` | `bench/apachejit/results-llm.md` | the report |

Rows come from the newest `rows/<name>.*.jsonl` of each project whatever build wrote it (the
hdfs/mapreduce `-in-hadoop` files included): the signals it holds do not depend on the LLM work, and
the `llm.*` signals are added per sampled row from its judgement. Judgements are cached in
`llm/<model>.<first 12 hex of sha256(system prompt)>.jsonl`, one `{sha, judgement}` or `{sha, error}`
line per commit, so a rerun with the same model and prompt only judges what is missing; cached
errors are retried once per run. A changed prompt gets a new file. Exit code 2 on a bad flag, a
missing key, or an empty sample.

## Run time

Cloning takes a while on the first run. The full replay is estimated at 3–8 hours on 16 cores;
`--concurrency` trades memory for speed, since each replay holds its project's history index. A smoke
run with `--max-per-project 300` takes minutes, and any run with a warm row cache takes seconds to a
few minutes (the pooled fits).

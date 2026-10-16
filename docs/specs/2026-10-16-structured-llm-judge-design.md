# Structured LLM judge (RADAR-style) — spec and plan

Status: design approved in chat 2026-10-16 (goal: gate + ranking; benchmark on sampled ApacheJIT with
an Anthropic model). Written as one document to fit a 2.5-hour delivery window.

## 1. Goal

RADAR (arXiv 2605.30208, §2.8) auto-accepts a diff only when its LLM reviewer puts **every change** in
a named safe category with confidence ≥ 8/10. opendrs's judge today returns one probability that can
only raise the score. This change makes the judge classify each hunk and uses that twice:

1. **Gate.** With `llm.requireSafe: true`, auto-approval also requires every hunk the judge saw to be
   safe at confidence ≥ `llm.minConfidence` (default 8), no hunk unclassified, and no truncation.
   Otherwise `human-review`, naming up to 3 hunks. The judge can only block, never unblock.
2. **Ranking.** Each risk category becomes a 0/1 signal `llm.risk.<category>` with a positive prior
   weight. Calibration floors every `llm.*` weight at 0, so no LLM output can lower a score.

`llm.semantic` (the probability) is unchanged.

Success: `npm run check` passes; the ApacheJIT LLM benchmark reports AUC/recall with and without the
LLM signals on a sampled test set, and the gate's precision (buggy rate among "all-safe" commits vs
the base rate).

## 2. Contract (`src/domain/types.ts`, already committed)

```ts
LLM_SAFE_CATEGORIES = ["refactor","dead_code","defensive","logging","formatting","docs","imports","tests","static_resources"]
LLM_RISK_CATEGORIES = ["logic_bug","security","performance","structural","complex"]
LlmHunkRef     { id, file, line }                         // a shown hunk; id = its [hunk N] marker
LlmHunkVerdict { file, line, category, safe, confidence /*0-10*/, reason }
LlmJudgement   { risk, rationale, riskySnippets, confidence, hunks: LlmHunkVerdict[],
                 unclassified: {file,line}[], truncated: boolean }
LlmJudgeInput  { title?, description?, diff, files, hunks: LlmHunkRef[], truncated }
LlmProvider.judge(input: LlmJudgeInput): Promise<LlmJudgement>
```

Config (`llm`): `requireSafe: boolean = false`, `minConfidence: int 0..10 = 8`; `requireSafe` without
`enabled` is a config error.

## 3. Components and owners

### Task A — prompt, parser, engine plumbing (`src/llm/*`, `src/engine.ts`)

- `buildDiffText(diff, maxChars)` returns `{ text, hunks: LlmHunkRef[], truncated }`. Each kept hunk
  is preceded by a line `[hunk N]` (N from 1, in output order). A diff body line always starts with
  `+`, `-`, ` `, `\` or `@`, so a marker line cannot be forged by diff content. `line` = hunk
  `newStart`, or `oldStart` when `newStart` is 0 (deletions). `truncated` = any hunk or file omitted.
  Budgeting must count the marker lines.
- System prompt: keep the existing risk/trust-boundary/calibration text; add the 14 categories with
  one-line definitions (RADAR §2.8: safe = refactor without behaviour change, dead code removal,
  defensive programming, logging additions, pure formatting, docs/comments, import hygiene, test
  additions, static resource updates; risk = logic bug, security issue, performance risk, substantial
  structural change, complex change needing careful review), the rule "classify every [hunk N]; when
  unsure choose a risk category", and the output shape:
  `{"risk", "confidence": 0-10, "rationale", "hunks": [{"hunk": N, "category", "confidence": 0-10, "reason"}], "risky_snippets": [...]}`.
- `parseJudgement(text, files, hunks: LlmHunkRef[], truncated)`: same one-JSON-object rule; zod
  schema with `category` an enum of the 14 names. Unknown hunk ids are dropped. A hunk answered twice
  keeps the riskier verdict (risk beats safe, then lower confidence). `confidence` clamped to [0,10],
  rounded. Shown hunks with no verdict go to `unclassified`. `safe` is derived from the category,
  never taken from the model. `hunks` reasons clipped to 200 chars. A missing top-level `confidence`
  or `hunks` is a parse error (the judge failed).
- Both providers pass `hunks`/`truncated` through to `parseJudgement`; `buildMessages` lists the hunk
  ids in a `<untrusted_hunks>`-free way (ids only, as trusted text: "Hunks to classify: 1, 2, …").
- `engine.ts`: build the diff text once, pass `hunks`/`truncated` to `judge`, and pass
  `llm: ctx.llm?.judgement` to `decide` (new `GateInput.llm`, Task B).
- Tests: `tests/llm/*` — marker placement and numbering across truncation, deletion line numbers,
  parse happy path, duplicate/unknown ids, unclassified, category enum rejection, `safe` not taken
  from the model, missing fields; fix existing fixtures for the new required fields.

### Task B — signals, model, gate, report

- `src/signals/llm.ts`: besides `llm.semantic`, emit `llm.risk.<c>` for each risk category: 1 when any
  verdict has category `c`, else 0; status `inferred`; evidence = those hunks (file, line, reason).
  On judge failure emit only the existing unknown `llm.semantic`.
- `src/model/defaults.ts`: priors `llm.risk.logic_bug` 0.6, `llm.risk.security` 0.6,
  `llm.risk.performance` 0.3, `llm.risk.structural` 0.3, `llm.risk.complex` 0.3; document them.
- `src/model/calibrate.ts`: floor every fitted weight whose id starts with `llm.` at 0.
- `src/policy/gate.ts`: `GateInput.llm?: LlmJudgement`. New rule right after the LLM-failure rule:
  when `config.llm.requireSafe` and a judgement exists, fire `human-review` if `truncated`
  ("LLM judge saw a truncated diff"), or any `unclassified` ("LLM judge did not classify N hunks:
  file:line…"), or any verdict not safe or below `minConfidence`
  ("LLM judge: not all hunks safe: file:line category (confidence c)…", at most 3 named, then
  "and K more"). PLAUSIBLE_RANGE gains `llm.risk.*` = [0, 1].
- `src/report/markdown.ts`: in the LLM details block, one line "Hunks: N safe (tests 2, docs 1), M
  risky" and up to 3 risky hunks `file:line — category (c/10): reason` (untrusted-escaped). Terminal
  summary gets the counts.
- Tests: signal values and evidence, calibrate floor (a negative fitted `llm.risk.*` weight becomes
  0), gate rule cases (off by default; all safe passes; one low-confidence safe hunk blocks; risk hunk
  blocks; truncated blocks; unclassified blocks; 3-name cap), markdown rendering.

### Task C — ApacheJIT LLM benchmark (`bench/apachejit/llm.ts`, README section)

```
node bench/apachejit/llm.ts [--work-dir] [--model claude-fable-5-1] [--train 1500] [--test 1500]
                            [--concurrency 16] [--out bench/apachejit/results-llm.md]
```

- Sample: replayed rows from the row cache of the latest full run (reuse `run.ts`'s cache format and
  loader; export what is needed from `run.ts` rather than copying), excluding `apache/hadoop`. Seeded
  shuffle (`mulberry32(1)`), first N of train and of test.
- Per sampled commit: `loadDiff(repoDir, sha^, sha, config, { resolved: true })` in the right clone
  (hdfs/mapreduce fall back to `hadoop`), `buildDiffText`, `provider.judge(...)` via
  `createLlmProvider(config)` with `llm.enabled = true`, `provider: anthropic`, `model` from the flag.
  Title = commit subject. Concurrency-limited.
- Cache: `<work-dir>/llm/<model>.<sha256(system prompt) first 12>.jsonl`, one line per sha:
  `{sha, judgement}` or `{sha, error}`. Reused across runs; errors are retried once per run.
- Evaluate on the sampled test rows (thresholds from sampled train rows, as `lib.ts` does):
  opendrs default priors without/with LLM signals; calibrated (fit on sampled train) without/with;
  Kamei LR. LLM signals for a row = `llmSignals` output for its judgement (failed → unknown semantic).
- Gate: among sampled test commits, share that would pass `requireSafe` at confidence 8, and their
  buggy rate vs the sample's base rate; same at confidence 6 and 9. Category table: per risk
  category, how many test commits it flagged and their buggy rate.
- Report: Markdown with model, prompt hash, sample sizes, judge failure count, token note, tables above.
- Never print or log the API key; read it only from `ANTHROPIC_API_KEY`.

### Task D — docs (coordinator)

README LLM section, `docs/specs/2026-10-15-opendrs-design.md` §5/§6 notes, CHANGELOG, calibration doc
results paragraph once the benchmark ran.

## 4. Invariants

- No LLM output lowers the score: `llm.*` values ≥ 0, weights ≥ 0 (prior and fitted).
- The gate can only add `human-review`; with `requireSafe: false` decisions are unchanged.
- Fail closed: parse failure → unknown `llm.semantic` + "LLM judge failed" (existing rule).
- Untrusted text: hunk reasons are model output shaped by the diff; render with `untrusted()`.

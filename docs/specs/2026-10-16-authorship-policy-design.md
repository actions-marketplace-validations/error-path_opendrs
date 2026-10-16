# Authorship classification and per-source policy — spec and plan

Status: approved in chat 2026-10-16 (roadmap target 2; delivered under a two-hour limit).

## 1. Goal

RADAR (arXiv 2605.30208) classifies each diff by source (human or bot runbook) and applies a policy
per source: its own DRS threshold, a daily landing cap, and a 60-day track record (enough landed
diffs, few reverts or incidents). opendrs will:

1. classify every PR as `human`, `bot` or `agent` (AI coding agent), with evidence;
2. let `.opendrs.yml` set, per source: a stricter green threshold, `requireSafe`, a daily cap of
   landed commits, and a track-record requirement;
3. show the source in the comment, terminal output and JSON.

**Only tightening.** Agent authorship comes from commit trailers and author emails, which the PR
author controls, so no per-source setting may loosen the base gate (schema enforces `green` below
`thresholds.green`). With no `sources` config, decisions are unchanged.

## 2. Contract (committed: `src/domain/types.ts`, `src/domain/config.ts`)

- `SourceKind = "human" | "bot" | "agent"`.
- `Authorship { kind, name, evidence: string[], verified }`; `verified` only when the kind came from
  the GitHub account type in CI.
- `CommitInfo.source: SourceKind` (history index, per commit).
- `ScoreResult.source: Authorship`.
- Config `sources.{human,bot,agent}`: `green?`, `requireSafe` (default false), `dailyCap?`,
  `trackRecord? { days = 60, minCommits = 10, maxRevertRate = 0.05 }`; `sources.agent.patterns`
  (extra case-insensitive regexes). Validation: `green < thresholds.green`; `requireSafe` needs
  `llm.enabled`; patterns must compile.

## 3. Classification (`src/policy/source.ts`, pure)

Per commit, from author name/email and the full message:

- **agent** when any of these match (case-insensitive), first match names the agent:
  - Claude Code: trailer `Co-Authored-By: Claude` (any model name) with `@anthropic.com`, or a
    line `Generated with [Claude Code]` / `Generated with Claude Code`;
  - GitHub Copilot coding agent: author or trailer email `…+Copilot@users.noreply.github.com`, or
    author login/name `Copilot` / `copilot-swe-agent[bot]`;
  - Cursor: `cursoragent@cursor.com` or trailer `Co-authored-by: Cursor Agent`;
  - OpenAI Codex: `chatgpt-codex-connector[bot]` or trailer `Co-authored-by: Codex`;
  - Devin: `devin-ai-integration[bot]`;
  - Google Jules: `google-labs-jules[bot]`;
  - Aider: trailer `Co-authored-by: aider` or a subject starting `aider: `;
  - any `sources.agent.patterns` regex (name: "pattern <regex>").
- **bot** when the author email ends `[bot]@users.noreply.github.com` or the name ends `[bot]`
  (name: the bot login), and it is not a known agent bot above.
- otherwise **human**.

`classifyCommit(c: { authorName, authorEmail, message }, extraPatterns: RegExp[]) → { kind, name, evidence }`.

Per PR, `classifyPr(commits, account?, extraPatterns) → Authorship`:

- `account` (CI only): the PR opener `{ login, type }`. `type === "Bot"` or a login ending `[bot]`
  makes the PR at least `bot`, `verified: true`; a known agent bot login makes it `agent`, verified.
- Otherwise the most-automated commit wins: any agent commit → `agent`; else all commits bot → `bot`;
  else `human`. Mixed human and bot commits are `human` (a person edited the bot's branch).
- Evidence: up to 3 lines, e.g. `commit 3f2a9c1: trailer "Co-Authored-By: Claude …"`, `PR opened by dependabot[bot] (GitHub App)`.

History: `buildHistoryIndex` fills `CommitInfo.source` with `classifyCommit` from the `%b` body it
already reads (and `sources.agent.patterns`).

## 4. Engine and Action

- `ScoreOptions.account?: { login: string; type?: string }`.
- The engine reads the PR's commits (`git log --format=%an%x00%ae%x00%B%x1e base..head`, non-merge),
  calls `classifyPr`, puts it on `ScoreResult.source`, and passes `source` to `decide`.
- `src/action/run.ts`: `PullRequest.user` gains `type?: string`; pass `account: { login, type }`.
- `score --json`, MCP `score_diff` and the report carry `source`.

## 5. Policy (`src/policy/gate.ts`)

`GateInput.source?: Authorship`. With `p = config.sources[source.kind]`, new rules right after the
freeze rule (rule 4 group), each only adding `human-review`:

1. `p.green` set: score ≥ effective green (absolute, or the percentile score from the model like the
   freeze rule; missing percentiles → block with a reason) → `source agent: score 0.24 ≥ source green 0.20`.
2. `p.requireSafe`: the `llm.requireSafe` rule applies as if it were on (same messages, prefixed
   `source agent:` is not needed; reuse the rule).
3. `p.dailyCap`: count `history` commits with `source === kind`, `time` in `(now − 24h, now]`, that are
   not part of this PR (exclude shas reachable from head but not base — use `diff.base`: a commit is
   "landed" when it is in the index and not in the PR range; the engine passes the PR's commit shas
   as `GateInput.prCommits: string[]`). Count ≥ cap → `source agent: daily cap reached (20 landed in 24h)`.
4. `p.trackRecord`: landed commits of the source in the last `days` (same exclusion); reverted = those
   named by a later revert commit's `revertsSha` (prefix match on ≥7 chars) in the index. Fewer than
   `minCommits` → `source agent: track record too short (4 of 10 landed commits in 60 days)`; revert
   rate > `maxRevertRate` → `source agent: 2 of 15 landed commits in 60 days reverted (13%) > 5%`.

`now` is `GateInput.now` (ms); history times are seconds.

## 6. Report

Markdown: one line under the score, `Source: agent (Claude Code)` with evidence in a `<details>` or
the existing signals section, escaped with `cell()`/`untrusted()` (names and evidence come from commit
messages). Terminal: `source: agent (Claude Code)`.

## 7. Tasks (parallel)

- **A — classification, history, engine, Action:** `src/policy/source.ts`, `src/git/history.ts`,
  `src/engine.ts`, `src/action/run.ts`, `src/mcp/*` if needed; tests `tests/policy/source.test.ts`,
  history/engine/action tests, and fixture fixes for `CommitInfo.source` / `ScoreResult.source`
  (`tests/policy/fakes.ts`, `tests/cli/helpers.ts`, `tests/explain.test.ts`, `tests/mcp/tools.test.ts`).
- **B — gate and report:** `src/policy/gate.ts` (`GateInput.source`, `GateInput.prCommits`, rules
  §5), `src/report/markdown.ts`; tests `tests/policy/gate.test.ts`, `tests/report/markdown.test.ts`,
  config tests in `tests/domain/config.test.ts`.
- **C — docs (coordinator):** README, CHANGELOG, `opendrs init` template comment, action bundle.

## 8. Testing

Classifier: each agent rule, bot vs agent bot, human default, extra patterns, mixed commits, account
override (Bot type, agent bot login), evidence cap. History: `source` per commit. Gate: no config →
unchanged; stricter green (absolute and percentile); requireSafe per source; daily cap counts only
landed commits of that kind inside 24h; track record short and high revert rate; rules never fire for
other kinds. Config: green ≥ base rejected, requireSafe without LLM rejected, bad pattern rejected.

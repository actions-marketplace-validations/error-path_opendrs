# How AI code reviewers judge PR risk, and what opendrs can take from them

Research note, 2026-10-18. Sources were read on that date. Anything taken from a page summary
rather than the file itself is marked *(relayed)*.

## Why this note

On ApacheJIT's held-out years, calibrated opendrs reaches AUC 0.819. That ties the Kamei JIT-metrics
regression (0.821), while DRS-OSS, a fine-tuned LLM that reads the diff, reaches 0.895
([docs/calibration.md](../calibration.md)). The prompted judge adds about +0.02 AUC (0.790 → 0.805
calibrated, 800 test commits). Its `requireSafe` gate is the stronger result: commits it passes are
5.3 % buggy, against a 25.5 % base rate ([bench/apachejit/results-llm.md](../../bench/apachejit/results-llm.md)).

The same report shows why the categories add so little. Of 800 test commits, the judge flags 393
(49 %) as `logic_bug` and 406 as `structural`, and those flagged sets are only 38.9 % and 37.4 %
buggy. `complex`, at 51.3 % on 76 commits, is the only category that separates well. The judge
flags almost everything as a risk, so the categories rank poorly.

This note asks how popular reviewers decide a change is risky, and which of their rules opendrs
could turn into deterministic signals, judge-prompt changes or gate rules.

## Part 1: The tools

### 1.1 Superpowers (obra/superpowers v6.4.1)

| | |
|---|---|
| **Source** | Superpowers v6.4.1: [`requesting-code-review/code-reviewer.md`](https://github.com/obra/superpowers/blob/v6.4.1/skills/requesting-code-review/code-reviewer.md) and [`receiving-code-review/SKILL.md`](https://github.com/obra/superpowers/blob/v6.4.1/skills/receiving-code-review/SKILL.md). There is no separate agent file in v6.4.1: the skill fills a template for a general-purpose subagent. |
| **What it looks for** | Five checklists. **Plan alignment.** **Code quality**: error handling, type safety, DRY, edge cases. **Architecture**: design, scalability, security, integration. **Testing**: tests that check real behaviour rather than mocks, edge cases, integration tests. **Production readiness**: a migration strategy if the schema changed, backward compatibility, docs. Where the spec is silent, it judges by what a reasonable user would expect. |
| **Severity** | Critical: bugs, security, data loss, broken functionality. Important: architecture, missing features, poor error handling, test gaps. Minor: style, optimisation, docs. "Not everything is Critical." |
| **Approval** | Gives a verdict, "Ready to merge? Yes / No / With fixes". Critical issues are fixed immediately and Important ones before proceeding. |
| **Notable** | It gets only the git range and the requirements, not the session history. It must list every behaviour it "declined to judge", so nothing is dropped silently. `receiving-code-review` tells the author to verify each item against the codebase before acting on it, and to push back on YAGNI suggestions. That is advice on how to receive a review, not a risk heuristic. |

### 1.2 Anthropic `/code-review` plugin (claude-code)

| | |
|---|---|
| **Source** | Five-agent version: [anthropics/claude-plugins-official `plugins/code-review/commands/code-review.md`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/commands/code-review.md). Newer four-agent version: [anthropics/claude-code `plugins/code-review/commands/code-review.md`](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md). |
| **What it looks for** | **claude-plugins-official version: five parallel reviewers.** (1) CLAUDE.md compliance. (2) A shallow scan of the diff for obvious bugs, "large bugs", not nitpicks. (3) Git blame and history of the modified code. (4) Comments on earlier PRs that touched the same files. (5) Compliance with guidance in code comments. **claude-code version: four agents.** Two check CLAUDE.md. Two are bug agents, told to flag only HIGH SIGNAL issues: code that will not compile or parse, code that "will definitely produce wrong results regardless of inputs", and clear CLAUDE.md violations. They must not flag issues that "depend on specific inputs or state". |
| **Severity** | No severity tiers. Each issue gets a 0–100 confidence score from a separate Haiku agent with a fixed rubric. 75 means "verified ... will be hit in practice", 100 means "definitely". Issues below 80 are dropped. The claude-code version replaces the score with a validation subagent per issue. |
| **Approval** | Never approves. Comments only, or says "No issues found". It skips closed, draft, trivial or automated PRs. |
| **Notable** | An explicit list of **false positives not to flag**: pre-existing issues, anything a linter or compiler would catch, general quality concerns such as test coverage unless CLAUDE.md requires them, intentional functional changes, and issues on lines the PR did not modify. |

The same marketplace ships the **pr-review-toolkit**
([claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit/agents),
[claude-code](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit/agents)).
Its `/review-pr` command
picks agents by what the diff touches: `silent-failure-hunter` if error handling changed,
`pr-test-analyzer` if tests changed, `type-design-analyzer` if types were added, `comment-analyzer`
if comments changed. Its general `code-reviewer` reports only issues at confidence ≥ 80, grouping
90–100 as Critical and 80–89 as Important.

`silent-failure-hunter` is the most specific checklist in any tool here. It flags empty catch
blocks, catch-and-continue, returning a default value on error, optional chaining that skips a
failing call, broad catches, unjustified fallbacks, and retries that give up silently. Severity is
CRITICAL for a silent failure or broad catch, HIGH for a bad message or unjustified fallback,
MEDIUM for missing context. `pr-test-analyzer` rates test gaps 1–10 (9–10 means data loss,
security or system failure). `feature-dev`'s `code-reviewer`
([source](https://github.com/anthropics/claude-code/blob/main/plugins/feature-dev/agents/code-reviewer.md))
uses the same ≥ 80 confidence filter.

### 1.3 Anthropic security review (`/security-review` and the security-guidance plugin)

| | |
|---|---|
| **Source** | [claude-code-security-review `.claude/commands/security-review.md`](https://github.com/anthropics/claude-code-security-review/blob/main/.claude/commands/security-review.md) and its [`findings_filter.py`](https://github.com/anthropics/claude-code-security-review/blob/main/claudecode/findings_filter.py). The security-guidance plugin: [`review_api.py`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/security-guidance/hooks/review_api.py) and [`patterns.py`](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/security-guidance/hooks/patterns.py). |
| **What it looks for** | **`/security-review`**: only security issues "newly added by this PR", in five groups: input validation (SQL, command, XXE, template, NoSQL injection, path traversal), authn/authz, crypto and secrets, injection and code execution, data exposure. **security-guidance, two stages.** First a regex check on every edit: 24 rules such as `eval_injection`, `child_process_exec`, `pickle_deserialization`, `innerHTML_xss`, `tls_verification_disabled`, `unsafe_yaml_load` and `github_actions_workflow`. Then an agentic LLM review with a list of "high-miss patterns", which **name concrete diff shapes**: *control regression* (a deleted fail-closed validator replaced by a single condition), *sibling-path gate parity* (a guard added to one branch or handler but missing from its siblings), *fail-open state drift*, *allowlist semantic escape*, *gate/action field mismatch*, *security-registry fanout* (a new enum or field missing from sanitiser and redaction lists), *IaC omitted arg*, *CI/CD trust* (`pull_request_target` without a branch filter). |
| **Severity** | `/security-review`: HIGH, MEDIUM, LOW. Confidence must be ≥ 0.8 to report, and false-positive subtasks drop anything below 8/10. security-guidance: critical, high, medium. Mediums are kept, because "dropping mediums ... filters out most real findings". |
| **Approval** | None. They report findings. |
| **Notable** | 17 hard exclusions, such as DoS, rate limiting, test-only files, docs, regex DoS and outdated dependencies, plus precedents such as "env vars and CLI flags are trusted". These are enforced by regex in `findings_filter.py`. security-guidance's refute pass sorts findings by whether they sit on a changed line. One that does not must name the +/- line that enables it, or it is refuted. |

### 1.4 engineering:code-review skill (Anthropic knowledge-work plugins)

| | |
|---|---|
| **Source** | [anthropics/knowledge-work-plugins `engineering/skills/code-review/SKILL.md`](https://github.com/anthropics/knowledge-work-plugins/blob/main/engineering/skills/code-review/SKILL.md). |
| **What it looks for** | **Security**: SQLi, XSS, CSRF, authn/authz, secrets, deserialisation, path traversal, SSRF. **Performance**: N+1, allocations, O(n²) in hot paths, missing indexes, unbounded queries or loops, resource leaks. **Correctness**: edge cases (empty, null, overflow), race conditions, error handling and propagation, off-by-one, type safety. **Maintainability.** |
| **Severity** | 🔴 Critical in a table; other items are suggestions. |
| **Approval** | Verdict: Approve, Request Changes, or Needs Discussion. |

### 1.5 Qodo PR-Agent (now The-PR-Agent/pr-agent)

`github.com/qodo-ai/pr-agent` now redirects to
[The-PR-Agent/pr-agent](https://github.com/The-PR-Agent/pr-agent). The README says Qodo donated
it to the community.

| | |
|---|---|
| **Source** | [`pr_reviewer_prompts.toml`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/settings/pr_reviewer_prompts.toml), [`configuration.toml`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/settings/configuration.toml), [`pr_code_suggestions_reflect_prompts.toml`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/settings/code_suggestions/pr_code_suggestions_reflect_prompts.toml), and the [review tool docs](https://github.com/The-PR-Agent/pr-agent/blob/main/docs/docs/tools/review.md). |
| **What it looks for** | Only "+" lines, "only on issues introduced by this PR". "For clear bugs and security issues, be thorough." For lower-severity issues it must be certain and name a concrete scenario. It does not flag declarations that may be defined elsewhere, design choices or style. |
| **Severity / risk fields** | **Fields on by default**: `estimated_effort_to_review_[1-5]` (size, complexity, quality), `relevant_tests` (Yes/No), `security_concerns` ("No" or a header), `key_issues_to_review` (at most `num_max_findings` = 3, "only ... issues you are confident about"). **Opt-in fields**: `risk_level` (low/medium/high, high only for a clear bug, security issue or major logic risk), `merge_recommendation` (`no_concerns_found` / `needs_review` / `changes_required`), `score` 0–100, `can_be_split`, and `failure_modes[]`, each with `what`, `where`, `trigger`, `detected_by` and `covered_in_this_pr`. |
| **Code-suggestion scoring** | A self-reflection pass scores each suggestion 0–10. **Score 0**: wrong, docstrings, type hints, unused imports, more specific exception types. **Capped at 7 or below**: "verify/ensure" suggestions. **Capped at 8 or below**: error-handling suggestions. **8–10**: reserved for major bugs or security. Score-0 suggestions are always dropped. |
| **Approval** | In open source, auto-approval is effectively off: `enable_auto_approval=false`, and the caller is commented out in `pr_reviewer.py`. Qodo Merge (paid) once documented `auto_approve_for_low_review_effort`, `auto_approve_for_no_suggestions` and `ensure_ticket_compliance` ([v0.31 docs](https://github.com/The-PR-Agent/pr-agent/blob/v0.31/docs/docs/core-abilities/auto_approval.md)). These keys are gone from current `main`. |
| **Labels** | `review effort [x/5]` and `possible security issue`. The docs suggest blocking merges on these labels "judiciously". When large-PR chunking merges chunk results, it keeps the highest effort, and no chunk can clear another chunk's security concern. |

### 1.6 Other reviewers

Most of these are hosted products, documented in their own docs. Kodus and Codex were also
checked in their source.

| Tool | What it looks for | Severity / risk | Approval logic | Source |
|---|---|---|---|---|
| **CodeRabbit** | 6 areas: security & privacy, stability & availability, data integrity & integration, functional correctness, performance & scalability, maintainability. A 1–5 "estimated code review effort" score from file count, the nature of the change and logic complexity. | Critical / Major / Minor / Trivial / Info. Profiles: `quiet`, `chill`, `assertive`. | `request_changes_workflow` approves once its comments are resolved and pre-merge checks pass. Checks in `error` mode block. | [overview](https://docs.coderabbit.ai/guides/code-review-overview), [config](https://docs.coderabbit.ai/reference/configuration), [pre-merge checks](https://docs.coderabbit.ai/pr-reviews/pre-merge-checks), [walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs) *(relayed)* |
| **GitHub Copilot review** | Bugs, security, style. Skips dependency manifests, logs and SVGs. Reads `copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md` and `REVIEW.md` from the **head** branch. | No public scheme. | "Comment" reviews by default. With approvals enabled at repo, org and enterprise level, its approval counts, and a new commit dismisses it. | [concepts](https://docs.github.com/en/copilot/concepts/agents/code-review), [how-to](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review) *(relayed)* |
| **Greptile** | Logic, syntax and style comments, using a codebase graph of callers and imports. It learns which comment types a team ignores, but never suppresses critical ones. | P0 / P1 / P2. A 0–5 PR confidence score that depends on context ("a 3/5 on payments is more serious"). | `autoApprove` approves "low-risk 5/5 reviews". The setting is read from the base branch, so a PR cannot loosen it. | [first review](https://www.greptile.com/docs/code-review/first-pr-review.md), [greptile.json](https://www.greptile.com/docs/code-review/greptile-json-reference.md), [nitpicks](https://www.greptile.com/docs/how-greptile-works/nitpicks.md) *(relayed)* |
| **Graphite Agent** | Logic bugs including off-by-one, edge cases (nulls, races), security, N+1, accidentally committed debug code. | Not documented. It tracks acceptance and downvote rates per rule. | Not documented. | [AI review comments](https://graphite.com/docs/ai-review-comments) *(relayed)* |
| **Ellipsis** | Several reviewers, each with its own prompt, model and budget. | Blocking or non-blocking only. | Passes only when no reviewer returned a blocking comment. A reviewer that fails or runs out of budget never produces an approval. | [code review](https://www.ellipsis.dev/docs/features/code-review) *(relayed)* |
| **cubic** | Custom rules and an optional 1–5 merge-risk confidence. | P1–P3. | Auto-approve in `shadow` or `live` mode, only with no blocking issues open. Its "low risk" means docs, test-only or small config changes. Sensitive paths (migrations, infra, auth) can be set to never auto-approve. External contributors are excluded by default. | [auto-approval](https://docs.cubic.dev/ai-review/auto-approval), [cubic.yaml](https://docs.cubic.dev/configure/cubic-yaml) *(relayed)* |
| **Kodus** (OSS) | Bug, security, performance and business-logic categories. The finder decides whether a bug is new or pre-existing, and reports a pre-existing one only if the PR "makes [it] newly reachable" or **removes a guard**. | Critical (crash, data loss, breach) / High / Medium / Low, from a separate classifier prompt. The default filter is medium. | Approves when no issues are found. Can request changes on critical issues. The verifier drops a finding only when it refutes it concretely ("when in doubt, KEEP"). | [severity-prompt.ts](https://github.com/kodustech/kodus-ai/blob/main/libs/code-review/infrastructure/agents/engine/severity-prompt.ts), [review-prompt-blocks.ts](https://github.com/kodustech/kodus-ai/blob/main/libs/code-review/infrastructure/agents/prompts/review-prompt-blocks.ts), [verifier-prompt.ts](https://github.com/kodustech/kodus-ai/blob/main/libs/code-review/infrastructure/agents/prompts/verifier-prompt.ts) |
| **Sourcery** | Labelled comments such as `issue (bug_risk)` and `nitpick (performance)`. Security findings are marked 🚨. | Quiet / Balanced / Verbose. | The status check fails when "blocking security findings require changes". It approves when nothing is worth blocking on. | [anatomy](https://docs.sourcery.ai/reviews/anatomy-of-a-review/), [configure](https://docs.sourcery.ai/reviews/configure/) *(relayed)* |
| **Cursor Bugbot** | Bugs, security and quality in the diff, reviewed incrementally. Reads `.cursor/BUGBOT.md`. | High / medium in examples. Full scale not documented. | Check is `neutral` when it finds issues. It is `failure` only if "fail on unresolved" is on. No approval. | [bugbot](https://cursor.com/docs/bugbot) *(relayed)* |
| **OpenAI Codex review** | A bug must be **introduced by the commit**, discrete, actionable, not reliant on unstated assumptions, and something the author would fix. "It is not enough to speculate": the affected code must be identified. | P0 (only issues that "do not depend on any assumptions about the inputs") / P1 / P2 / P3. Per-finding `confidence_score`. Overall verdict "correct" or "incorrect". The GitHub integration posts P0 and P1 only. | Posts reviews. No auto-approval documented. | [rubric.md](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/review/rubric.md), [GitHub integration](https://learn.chatgpt.com/docs/third-party/github) *(relayed)* |

### 1.7 What the tools share

1. **Only what the diff introduces.** Codex, PR-Agent, Kodus, `/code-review` and `/security-review`
   all exclude pre-existing issues and unchanged lines.
2. **Concrete failure mode or nothing.** A finding must name a trigger, input or affected caller
   (Codex rule 7, PR-Agent "concrete scenario" and `failure_modes.trigger`, claude-code `/code-review`
   "wrong results regardless of inputs"). Speculation is a false positive.
3. **Find, then verify.** A second pass scores or refutes each finding before it counts:
   `/code-review` (≥ 80 / validation agents), `/security-review` (≥ 8/10), security-guidance (refute),
   Kodus (verifier), PR-Agent `/improve` (reflection score). BitsAI-CR reports 75 % precision after
   such a filter ([arXiv 2501.15134](https://arxiv.org/abs/2501.15134)).
4. **Severity anchored to impact.** Every scheme puts crash, data loss and security breach at the
   top, and style and docs at the bottom.
5. **Approve only when nothing blocking is open.** CodeRabbit, cubic, Ellipsis, Kodus and Greptile
   (5/5) all work this way. A failed reviewer never produces an approval (Ellipsis), and some
   settings are read from the base branch so a PR cannot loosen them (Greptile). opendrs already
   behaves this way: `llmFailed` sends the PR to a human, `requireSafe` must pass, and `.opendrs.yml`
   is in `paths.block`.
6. **Heuristics are mostly checklists the LLM applies.** Only security-guidance (regex rules) and
   PR-Agent's effort label are partly mechanical. No tool publishes evidence that any one checklist
   item predicts defects.

## Part 2: Consolidated heuristics

**Columns.**
- **Tools**: how many of the 17 reviewers in Part 1 name the heuristic explicitly (sections 1.1–1.6,
  counting pr-review-toolkit and security-guidance separately). opendrs's own prompt is not counted.
- **opendrs today**: the signal, gate rule or prompt line that covers it, from `src/signals/*`,
  `src/policy/gate.ts` and `src/llm/prompt.ts`.
- **Deterministic**: whether it can be computed from the diff and git history alone. *Yes*,
  *partly* (a regex proxy with known misses) or *needs LLM*.

| # | Heuristic | Tools | opendrs today | Deterministic |
|---|---|---|---|---|
| H1 | **Error handling changed or removed**: catch/except/finally/throw edited, empty or broad catch, swallowed error, new fallback | 5: Superpowers, pr-review-toolkit (silent-failure-hunter), engineering, PR-Agent (error-handling suggestions capped at 8), security-guidance (fail-open) | Prompt line "error handling: swallowed errors, removed fallbacks …". No signal. | **Partly.** Count +/- lines matching `catch\|except\|finally\|throw\|raise\|rescue\|recover\(`. Empty catch: `catch (…) {}` on one line, or `{` then `}`. |
| H2 | **Guard, validation or assertion removed**: deleted null check, `if … throw`, `assert`, `Preconditions.check*`, `requireNonNull` | 2: security-guidance (control regression), Kodus ("removes a guard") | Prompt line "removal of checks". Safe category `defensive` covers the *added* direction only. No signal. | **Partly.** Deleted lines with guard idioms and no matching added line in the same hunk. |
| H3 | **Concurrency touched**: locks, `synchronized`, `volatile`, atomics, executors, async ordering, shared mutable state | 4: engineering, pr-review-toolkit (code-reviewer, pr-test-analyzer), Graphite, security-guidance (TOCTOU) | Prompt line "concurrency: locking, async ordering …". No signal. | **Yes (proxy).** Keyword regex on +/- lines, per language family. |
| H4 | **Public API or signature change, backward compatibility** | 4: Superpowers (backward compatibility), PR-Agent (don't guess breakage without naming the path), Codex (rule 7), Greptile (graph) | **`blast.public_surface`**, **`blast.dependents`** | Yes. Already done. |
| H5 | **Auth, permission or crypto code edited** | Auth specifically: 3 (`/security-review`, security-guidance, engineering). Security in general: nearly all. | **`paths.critical`** (globs `**/auth/**` …), judge category `security` | **Partly.** Paths are done. Content proxy (`hasRole`, `authorize`, `Cipher`, `MessageDigest`, `jwt`) is not. |
| H6 | **Dangerous sink added**: eval/exec, deserialisation, raw SQL, innerHTML, TLS verification off | 4: security-guidance (24 regex rules), `/security-review`, engineering, Graphite | `content.block` regexes (user-supplied, default empty). Prompt line "injection". | **Yes.** security-guidance's rules are a ready list. |
| H7 | **Tests weakened**: asserts removed, tests skipped or disabled, expected values edited | 2: pr-review-toolkit (pr-test-analyzer), Superpowers ("tests verify real behaviour") | **`tests.deleted`** (file or ≥ 10 net lines, also a gate rule), **`tests.missing`** | **Yes** for removed asserts and added `@Ignore` / `@Disabled` / `skip`. Not covered today. |
| H8 | **Config default, constant or limit changed**: timeouts, flags, thresholds, boundary operators | 4: opendrs prompt, engineering (off-by-one), security-guidance (exact boundary, IaC omitted arg), Graphite (off-by-one) | Prompt line "config defaults". `paths.block` covers build and CI files. | **Partly.** Pair - and + lines that differ in exactly one literal or comparison operator. |
| H9 | **Schema or data migration** | 3: Superpowers, security-guidance (DDL drops constraint), cubic (never auto-approve migrations) | **`paths.block`** (`**/migrations/**` …) | Yes. Already done. |
| H10 | **Change size and review effort** | 3: PR-Agent effort 1–5, CodeRabbit effort 1–5, cubic "small config edits" | **`size.churn`**, **`size.relative`**, **`diffusion.*`**, `autoApprove.maxChangedLines` | Yes. Already done. |
| H11 | **Tangled change, can be split** | 1: PR-Agent `can_be_split` | `diffusion.dirs` (proxy) | **Partly.** Connected components of changed files in the import graph. |
| H12 | **History of the touched code**: blame, earlier fixes, comments on earlier PRs | 1: `/code-review` agents 3 and 4. Meta DRS uses previous SEVs. | **`history.prior_fixes`**, **`history.incident`**, **`history.churn`**. Prior PR comments not used. | Yes for git. Needs the GitHub API for PR comments. |
| H13 | **Project rules** (CLAUDE.md, AGENTS.md, REVIEW.md, path instructions) | 10: `/code-review`, pr-review-toolkit, Copilot, Codex, Bugbot, CodeRabbit, Graphite, Sourcery, cubic, Kodus | None. The judge sees only the diff, title and description. | Needs LLM. |
| H14 | **Rules in code comments** ("do not call without lock", TODOs) | 2: `/code-review` agent 5, PR-Agent `todo_sections` | None | Needs LLM. TODO/FIXME added is a regex. |
| H15 | **Sibling-path parity**: a guard added to one branch or handler but not its siblings | 1: security-guidance | None | Needs LLM, with file context. |
| H16 | **Performance**: N+1, unbounded loops, O(n²) | 5: engineering, Graphite, CodeRabbit, Kodus, PR-Agent `/improve` | Judge category `performance` | Needs LLM. Only 8 of 800 test commits were flagged, so it is a weak signal on ApacheJIT. |
| H17 | **Resource leaks**: streams, connections | 2: engineering, pr-review-toolkit. `/security-review` explicitly excludes them. | None | Partly. |
| H18 | **Debug or commented-out code committed** | 1: Graphite | `size.comment_only` treats comment edits as inert, which is the opposite direction | Yes (`println`, `console.log`, `printStackTrace`, large commented blocks). |
| H19 | **Low-risk shapes**: docs, tests only, formatting, logging, comments | 5: RADAR, cubic, PR-Agent (score 0 for docstrings), `/code-review` (skip trivial), Meta DRS | **`size.comment_only`**, safe categories, `size.new_files_only` | Yes for comments and docs. Logging and refactor need the LLM. |
| H20 | **Author and source trust**: external contributor, bot, agent | 3: cubic, Greptile, `/code-review` (skip automated PRs) | **`sources.*`**, `expertise.*`, `policy/source.ts` | Yes. Already done. |
| H21 | **Introduced by this diff, not pre-existing** | 6: Codex, PR-Agent, Kodus, `/code-review`, `/security-review`, security-guidance | Not stated in the prompt | Prompt rule, not a signal. |
| H22 | **Concrete trigger required for a risk claim** | 5: Codex, PR-Agent, claude-code `/code-review`, Kodus, `/security-review` | Partly: "Go above 0.5 only when you can name a concrete, plausible failure mode" applies to `risk`, but not to the hunk categories. | Prompt rule. |

**Literature context.** No paper we found measures H1, H2, H3 or H8 as JIT-defect predictors on
their own. The tools use them as checklist items, which is not evidence that they predict defects.
Each one has to earn its weight on ApacheJIT. See Part 4.

## Part 3: Recommendations, ranked

Ranked by expected value per unit of effort. "Bench" refers to
[bench/apachejit/README.md](../../bench/apachejit/README.md). There are two ways to measure:

- **Deterministic signals** need a full replay with `run.ts` (3–8 h on 16 cores; the row cache is
  keyed by opendrs version, so any `src/` change invalidates it). Compare the pooled calibrated AUC
  and captured@10/30 % against **0.819 / 29.1 % / 66.1 %**. Also report each signal's prevalence and
  the buggy rate when it is 1, against the 23.6 % pooled base rate.
- **Prompt changes** use `llm.ts`. Judgements are cached per prompt hash, so a new prompt re-judges
  the same seeded 800 + 800 commits, at about $55 with Sonnet 5. Compare against calibrated+LLM
  **0.805 AUC / 28.4 % / 60.8 %**, and against the gate row: **28.5 % passing at 5.3 % buggy** at
  confidence 8.

With 800 test commits, differences around 0.02 AUC are within noise
([docs/calibration.md](../calibration.md)). For a prompt change, the gate row and the per-category
buggy rates are the more sensitive readouts.

### R1. Make the judge report concrete findings, not just categories (prompt and schema)

**Change.** Keep `risk` and the hunk classification. Add a `findings` array, at most 5 entries,
each with `hunk`, `priority` (P0–P3, Codex's definitions), `confidence` (0–1), `trigger` (the input
or state that makes it fail) and `introduced` (true only if the defect is on a changed line). This
follows PR-Agent's `failure_modes` (`what`, `where`, `trigger`) and Codex's rubric.

Require a non-empty `trigger` for any risk-category hunk. Tell the judge that a hunk with no
nameable trigger is safe or `complex`, not `logic_bug`. That is the "concrete failure mode or
nothing" rule all five strict reviewers share.

Add signals `llm.finding.p0p1` (count of P0 or P1 findings at confidence ≥ 0.8, as `log1p`) and
`llm.finding.any` (0/1).

**Why.** `logic_bug` fires on 49 % of commits at 38.9 % buggy. A category that fires on half the
commits cannot rank them. Findings with triggers are what the tools treat as signal.

**Expected value.** High. It targets the weak +0.02 AUC directly.

**Effort.** Medium: `src/llm/prompt.ts`, `schema.ts`, `parse.ts`, `src/signals/llm.ts`, `llm.ts` reporting.

**Measure.** `llm.ts` with the new prompt. Report AUC and captured@10/30 % with the new signals; a
buggy-rate table per priority, like the risk-category table; and the share of commits with
`logic_bug` (target: well under 49 %, with a higher buggy rate).

### R2. A gate rule on verified high-priority findings

**Change.** Once R1 exists, add a gate rule: any P0 or P1 finding at confidence ≥ 0.8 sends the PR
to human review, with the finding in the comment. This is the "approve only when nothing blocking
is open" rule that CodeRabbit, cubic, Ellipsis and Kodus use. It sits alongside `requireSafe`. It
can only block.

**Expected value.** Medium. It should push the passing set's buggy rate below 5.3 % at little cost
in pass rate.

**Effort.** Small once R1 exists (`gate.ts`, config key, docs).

**Measure.** Extend the `llm.ts` gate table with a row for `requireSafe` plus the findings rule:
commits passing and buggy among them.

### R3. Separate find from verify (two-pass judge)

**Change.** A second, cheaper call gets the diff and the R1 findings. It must refute each one with
evidence or keep it. Use security-guidance's "default SURVIVES unless concrete refuting evidence" or
Kodus's "refute-to-drop". Only surviving findings feed R1's signals and R2.

**Expected value.** Medium. Every multi-agent reviewer here does this, and BitsAI-CR credits its
filter stage for 75 % precision. The gain shows up as precision, so it matters most for R2.

**Effort.** Medium. It doubles calls per PR, which roughly doubles judge cost for PRs that have
findings.

**Measure.** Same `llm.ts` sample, with and without verification: the finding-level buggy rate and
the gate row.

### R4. Deterministic "removed safety code" signal (H1 + H2)

**Change.** Add `change.safety_removed`, set to `log1p` of deleted lines that are error handling
(`catch`, `except`, `finally`, `throw`/`raise`, `rescue`) or guards (`if (… == null|!= null)`,
`assert`, `Preconditions.check*`, `Objects.requireNonNull`, `checkArgument|checkState`, `require(`)
and have no added line with the same idiom in the same hunk.

Add a companion `change.error_handling`, 0/1, set when any +/- line touches error handling, plus
empty-catch detection on added lines. Use `changedLines()` the way `contentHits` does in `gate.ts`.

**Why.** Five tools list error handling, and opendrs's own prompt lists both halves.
security-guidance's "control regression" and Kodus's "removes a guard" turn guard removal into a
named rule. It is cheap, language-agnostic in spirit, and needs no API call.

**Expected value.** Medium, unproven. The literature does not measure it (Part 2).

**Effort.** Small: one signal file, priors, a `PLAUSIBLE_RANGE` entry, docs.

**Measure.** `run.ts` replay. Report prevalence and buggy rate when set, and the calibrated weight
and AUC delta. Keep it only if the fitted weight is positive and stable across projects.

### R5. Deterministic concurrency signal (H3)

**Change.** Add `change.concurrency`, 0/1, set when a +/- line in a code file matches a
per-language family of concurrency idioms. For Java: `synchronized`, `volatile`, `Lock`,
`ReentrantLock`, `Atomic\w+`, `ExecutorService`, `CompletableFuture`, `ConcurrentHashMap`,
`wait(`/`notify`, `Thread`, `CountDownLatch`. Go: `go func`, `chan`, `sync.`. JS/TS/Python/Rust:
`async`/`await`, `Mutex`, `threading`.

**Why.** Four tools name races. ApacheJIT's projects (Cassandra, HBase, ZooKeeper, Kafka, Ignite,
Flink) are concurrency-heavy, so this benchmark is a fair test. The judge cannot see that a field is
shared from a hunk alone, but a keyword at least marks where to look.

**Expected value.** Medium, unproven.

**Effort.** Small.

**Measure.** As R4.

### R6. Tests weakened: signal and gate rule (H7)

**Change.** Extend `tests.deleted`, or add `tests.weakened`. It fires on net-deleted assertion
lines in test files (`assert\w*\(`, `expect(`, `verify(`, `should`) or on added skip markers
(`@Ignore`, `@Disabled`, `@Test(enabled = false)`, `pytest.mark.skip`, `xit(`, `it.skip`,
`t.Skip(`). Treat it like `tests.deleted` in the gate: it always goes to human review.

**Why.** `tests.deleted` misses a PR that keeps the test file but deletes three asserts, or disables
a test. pr-test-analyzer and Superpowers both treat tests that check real behaviour as the bar.

**Expected value.** Medium as a gate rule (a hard-to-game safety property), low for ranking.

**Effort.** Small (`src/signals/tests.ts`, one gate line).

**Measure.** `run.ts`: prevalence and buggy rate. For the gate, count test commits it newly routes
to humans and their buggy rate against the base rate.

### R7. Tighten the judge's "do not flag" list and category definitions (prompt)

**Change.** Add the exclusions the strict reviewers share:
- pre-existing code;
- anything a compiler or linter catches, such as imports or symbols that may be defined elsewhere
  (PR-Agent);
- style;
- missing tests in general (the `tests.*` signals already cover that);
- intentional behaviour changes that match the title.

Narrow `structural` to new modules, interfaces, data flow or schema. Today it fires on 51 % of
commits. State that most hunks of a typical change are safe.

This can ship in the same prompt revision as R1. Run it alone first if budget allows, to see what
each change does.

**Expected value.** Medium. Fewer false risk categories should move the gate pass rate up without
raising its buggy rate.

**Effort.** Small (prompt only).

**Measure.** `llm.ts`: per-category share and buggy rate, and the gate row.

### R8. Give the judge context beyond the hunk (prompt input)

**Change.** Add two trusted blocks to the judge input.
- **History.** The subjects of the most recent fix and revert commits that touched each changed
  file. `history.prior_fixes` already collects them as evidence. This is `/code-review` agent 3's
  history review, done without a second agent.
- **Enclosing context.** The enclosing method or class header for each hunk, within a character
  budget.

**Why.** security-guidance says the diff alone "is not enough". CodeFlowLM finds that prompted LLMs
lack context and over-flag ([arXiv 2512.00231](https://arxiv.org/abs/2512.00231)). Greptile's whole
design is caller context.

**Expected value.** Medium to high, but uncertain. More tokens also mean more truncation, and a
truncated diff already fails `requireSafe`.

**Effort.** Medium. Enclosing context needs base and head reads per hunk, which already exist
(`ctx.readBase` / `readHead`).

**Measure.** `llm.ts`. Also report the cost delta and the truncation rate.

### R9. Ship security-guidance's sink rules as an opt-in preset (H6)

**Change.** Add an opt-in `content.block` preset, or a `change.dangerous_sink` signal, built from
security-guidance's `patterns.py` rule names: `eval_injection`, `child_process_exec`,
`os_system_injection`, `pickle_deserialization`, `unsafe_yaml_load`, `innerHTML_xss`,
`tls_verification_disabled`, `aes_ecb_mode`. Re-implement the regexes rather than copying them, and
check the licence first.

**Expected value.** Low on ApacheJIT (Java, and only 18 of 800 commits flagged `security`). Medium
for real users, as a hard gate that needs no LLM.

**Effort.** Small.

**Measure.** On ApacheJIT, prevalence only. Its value is as a gate rule, which the benchmark's
labels do not test well.

### R10. Literal or operator flip signal (H8)

**Change.** Add `change.literal_flip`: the count of `-`/`+` line pairs in a hunk that are identical
except for one numeric or boolean literal, or one comparison operator (`<` ↔ `<=`, `==` ↔ `!=`,
`&&` ↔ `||`).

**Why.** Off-by-one, boundary and config-default changes are on four checklists. They are also the
diffs a size model scores as tiny, so they are its blind spot.

**Expected value.** Low to medium, unproven. Such edits may be more typical of *fixes* than of
bug-inducing commits, so the fitted sign may be negative.

**Effort.** Medium (line pairing).

**Measure.** `run.ts`. Look at the fitted sign and the buggy rate, and drop the signal if it is
indistinguishable from `size.churn`.

### Not recommended now

- **H13 project rules (CLAUDE.md) in the judge.** Ten tools use it, but ApacheJIT's 2003–2019
  commits have no such files, so the benchmark cannot measure it. Revisit when opendrs has a
  real-repo evaluation.
- **Feeding opendrs's own signal values to the judge.** DRS-OSS does this, with bucketed Kamei
  metrics as tokens ([arXiv 2511.21964](https://arxiv.org/abs/2511.21964)). In a prompted (not
  fine-tuned) judge, it risks anchoring the judge on numbers the logistic model already weighs, and
  DRS-OSS reports no ablation showing it helps.

## Part 4: Literature context

All papers below were checked on arxiv.org on 2026-10-18. Summaries come from abstracts and
sections a research pass read. They are *(relayed)* unless marked otherwise.

- **DRS-OSS** ([2511.21964](https://arxiv.org/abs/2511.21964)). Llama 3.1 8B fine-tuned with LoRA.
  Its input is the commit message, a compacted diff and Kamei-style metrics as bucketed tokens.
  ApacheJIT, 80/10/10 chronological split. AUC 0.895, F1 0.641. There is **no ablation**, so the
  paper does not show how much comes from the diff and how much from the metrics it is also fed.
- **RADAR** ([2605.30208](https://arxiv.org/abs/2605.30208)). Section 2.8 describes the pipeline
  (static gates, then a DRS threshold, then an LLM reviewer at ≥ 8/10 confidence), not related work.
  Section 2.4 explains what the LLM adds: static checks cannot tell what a change does. The LLM
  clears large refactors that metrics would flag, and catches logic errors. Its safe and risk
  categories are the ones opendrs uses. No DRS-only vs DRS+LLM ablation is published.
- **Meta DRS** ([2410.06351](https://arxiv.org/abs/2410.06351)). About 12 LR features. The authors
  give the example of a comment-only diff flagged because its file had a past SEV. That is the
  history false positive `size.comment_only` handles.
- **SimCom++** ([2403.11079](https://arxiv.org/abs/2403.11079)). Expert-feature and content models
  each catch about 20 % of defective commits the other misses. Fusing them gains 5.7–26.9 %. This
  is the best evidence that an LLM signal can add to metrics, but it says nothing about *which*
  changes each side catches.
- **ReDef** ([2509.09192](https://arxiv.org/abs/2509.09192)). Code language models kept the same
  F1 when added and deleted blocks were swapped. They rely on surface tokens, not on what the
  change does. This is a caution for any LLM signal, and an argument for R1's trigger requirement.
- **Refactoring ≠ bug-inducing** ([2507.19714](https://arxiv.org/abs/2507.19714)). Refactorings
  tangled with other changes mislabel 13.7 % of JIT-Defects4J. Semantic models suffer most when
  refactoring is ignored. This supports the `refactor` safe category, and warns that SZZ labels
  (ApacheJIT's) are noisy in exactly that way.
- **CodeFlowLM** ([2512.00231](https://arxiv.org/abs/2512.00231)) and **Prime Video**
  ([2607.06766](https://arxiv.org/abs/2607.06766)). Prompted frontier LLMs are over-conservative
  classifiers. Prime Video reports zero- and few-shot F1 of 0.22–0.26, but LLMs work well as
  *feature extractors*. Prime Video also finds structural complexity beats churn. This matches
  opendrs's experience: the judge works better as a gate and a source of features than as a risk
  number.
- **Reviewer comment studies.** About 74 % of automated comments are resolved in one industrial
  study ([2412.18531](https://arxiv.org/abs/2412.18531)). LLM reviewers write more bug comments
  than humans ([2510.05450](https://arxiv.org/abs/2510.05450)). 36 % of CodeRabbit comments are
  accepted, and functional comments are more often invalid
  ([2607.03316](https://arxiv.org/abs/2607.03316)). Incorrect suggestions are the top reason for
  rejection ([2607.21997](https://arxiv.org/abs/2607.21997)). Precision is the known weak spot,
  which is why R3 exists.

**Gap.** None of these papers measures error-handling, guard-removal, concurrency or
literal-flip features as JIT predictors on their own. R4, R5 and R10 are hypotheses to test
on ApacheJIT, not borrowed results.

## Part 5: Pre-registered plan for the next LLM-judge experiment

Written 2026-10-18, before any API spend, and revised the same day after the user reframed the
question.

**The question.** Does an LLM reviewer plus opendrs beat the LLM reviewer alone, by enough to
justify any extra tokens? It is not opendrs against the LLM.

**The three headline arms**, run on the same commits:
1. **The LLM alone:** a `/code-review`-style reviewer that reports findings with a severity.
2. **The LLM given opendrs's context:** the risk score, the top signals, file history, blast radius
   and dependents, prior fixes and incidents, and the hunks to focus on. It may use the same or
   modestly more tokens.
3. **The LLM with opendrs as the decision layer:** the LLM's findings combined with opendrs's
   signals in the calibrated logistic model, plus the `requireSafe` gate.

Budget-limited routing stays as one secondary arm.

**Headline metrics:**
- bugs caught (recall) at a fixed review budget;
- precision of the flagged commits;
- the false-positive rate;
- LLM tokens per bug caught.

**Budget.** About $43 of API credit. Prices are per million tokens: Claude Sonnet 5 $2 input /
$10 output, Claude Haiku 4.5 $1 / $5. The Message Batches API halves both.

### 5.1 What the cached data already shows ($0)

[`bench/apachejit/judge-sim.ts`](../../bench/apachejit/judge-sim.ts) reuses the Sonnet 5
judgements of the first LLM run (the current judge prompt), the replay rows and the labels. It
needs no API calls and no clones.

- **Sample.** The 800 seeded test commits, 204 of them buggy (25.5 %).
- **LLM tokens.** Estimated from diff size, the cached reply and ~1,000 thinking tokens: about
  6.43 M for all 800, or $0.032 a commit. That is close to the ~$0.034 the first run cost.
- **Fits.** The model that combines the LLM with opendrs is fitted on the 800 judged training
  commits. opendrs's free score is calibrated on all 41,967 replayed training commits.

**Arm 3, the decision layer, measured for free.** Every ranking sends its riskiest share of
commits to review.

| Ranking | AUC | Bugs caught at a 10 % review budget | Precision | False-positive rate | LLM tokens per bug |
|---|---:|---:|---:|---:|---:|
| LLM alone (snippet count, then its risk) | 0.789 | 51 (25.0 %) | 63.7 % | 4.9 % | 126 k |
| LLM alone (fitted on its own outputs) | 0.772 | 47 (23.0 %) | 58.8 % | 5.5 % | 137 k |
| **LLM + opendrs** (calibrated + `llm.*` + snippet count) | **0.824** | **60 (29.4 %)** | **75.0 %** | **3.4 %** | **107 k** |
| opendrs alone (free score), for reference | 0.817 | 56 (27.5 %) | 70.0 % | 4.0 % | 0 |

| Ranking | Bugs caught at a 30 % budget | Precision | False-positive rate | LLM tokens per bug |
|---|---:|---:|---:|---:|
| LLM alone (snippet count, then its risk) | 125 (61.3 %) | 52.1 % | 19.3 % | 51 k |
| LLM alone (fitted on its own outputs) | 122 (59.8 %) | 50.8 % | 19.8 % | 53 k |
| LLM + opendrs | 131 (64.2 %) | 54.6 % | 18.3 % | 49 k |

- **opendrs as the decision layer beats the LLM alone at no extra tokens.** AUC rises by +0.035
  over the best LLM-alone ranking. Against the fitted LLM-alone model the gain is +0.052 (paired
  bootstrap 95 % CI +0.026 to +0.077).
- **The gain is clearest at small review budgets.** At 10 %, LLM + opendrs catches 60 bugs
  against 47–51, with 15–22 % fewer LLM tokens per bug caught.
- **At 30 % the difference is small.** LLM + opendrs catches 131 bugs against 122–125. The gain
  over the fitted model, +4.4 points, has a 95 % CI of −1.0 to +9.9 points, so it is not
  significant on 800 commits.

**The gate.** The LLM alone auto-approves when `requireSafe` passes: 228 commits (28.5 %), 12 of
them buggy (5.3 %). LLM + opendrs also requires opendrs's free score to be below its median on
the training commits: 198 commits (24.8 %), 7 of them buggy (3.5 %). Review then catches 197
instead of 192 of the 204 bugs.

**Where the gain comes from.** The judge's risky snippets carry most of its signal. The share of
commits that turn out buggy rises with the snippet count: 7.0 % at 0, 23.3 % at 1, 43.3 % at 2,
57.7 % at 3, 63.2 % at 4 and 91.7 % at 5. Calibrated AUC with the LLM's outputs added:

| Calibrated on the 800 judged training commits | Test AUC |
|---|---:|
| Without LLM signals | 0.809 |
| + the current `llm.*` signals | 0.819 (+0.010, 95 % CI −0.000 to +0.022) |
| + `llm.snippets` (`log1p` of the snippet count) alone | 0.823 (+0.015, 95 % CI +0.004 to +0.025) |
| + both | 0.824 |

These were found on the same test commits, so they are exploratory. Phase 1 re-tests them with
an independent prompt's findings.

**Routing (secondary arm).** At equal spend, sending the LLM only to opendrs's riskiest commits
flags 34–43 % more buggy commits than a random subset. That is 55 against 38.4 at $5.39, and 123
against 91.9 at $12.88. Spend falls less than the commit share: the riskiest 30 % of commits cost
50 % of the judging spend.

**Statistical power.** The paired bootstrap SE of an AUC difference on these 800 commits is
0.0026–0.0056. At 80 % power and two-sided α = 0.05:
- **AUC gains:** +0.02 needs 110–500 test commits. So the 800 cached test commits, reused with a
  paired test, are enough for an AUC gain of +0.02.
- **Recall at a 30 % budget:** a +5-point gain is not reliably detectable at n = 800. The 95 % CI
  above is about ±5.5 points wide.
- **Gate buggy rate:** a 2-point change needs about 1,600 auto-approved commits per arm, or about
  5,600 judged commits.

So AUC is the primary metric, and recall, precision, false-positive rate and the gate are
reported with intervals.

### 5.2 Literature that shapes the design

Every number below is from a research pass over arXiv HTML pages, mostly through a summarising
fetch tool *(relayed)*.

**Complementary errors.** The best evidence for "LLM + metrics" is complementarity. Expert-feature
and content models each catch about 20 % of the defective commits the other misses, and fusing
them gains 5.7–26.9 % (SimCom++, [2403.11079](https://arxiv.org/abs/2403.11079)). Arm 3 relies on
this.

Arm 2 risks the opposite: an LLM that reads opendrs's score may copy it, which would erase the
independence. 5.8 says how that is measured.

**Prompted vs fine-tuned JIT prediction.**
- No prompted LLM matches a fine-tuned one. DRS-OSS ([2511.21964](https://arxiv.org/abs/2511.21964))
  fine-tunes Llama 3.1 8B with Kamei-style metric tokens ahead of the message and a compacted diff,
  and reaches AUC 0.895.
  - This is the closest published analogue of arm 2: metrics given to the model as context.
  - It publishes no ablation, so the context's own effect is unknown.
- Meta's diff-pretrained 13B beat a 34B code model ([2410.06351](https://arxiv.org/abs/2410.06351)).
- Prompted Sonnet 4.5 over-flags: recall 0.79 and precision 0.14 at a 5 % base rate
  ([2607.06766](https://arxiv.org/abs/2607.06766)).
  - CodeFlowLM saw 2× more false positives than false negatives with GPT-5
    ([2512.00231](https://arxiv.org/abs/2512.00231)).
  - Both papers report the false-positive rate, which is why it is a headline metric here.
- More context in the prompt helps only when it is the right context:
  - ZeroFalse ([2510.02534](https://arxiv.org/abs/2510.02534)) gained +0.33 F1 from dataflow and
    CWE context.
  - ReDef ([2509.09192](https://arxiv.org/abs/2509.09192)) found longer raw code did not help.

**Find-then-verify** (for a later round). Every verify step checks each finding on its own.
- BitsAI-CR ([2501.15134](https://arxiv.org/abs/2501.15134)): precision 57.0 → 65.6 %, recall
  45.5 → 39.8 %, with the verdict before the reasoning.
- Atlassian RovoDev ([2601.01129](https://arxiv.org/abs/2601.01129)) found an actionability gate
  worth +20 points of comment-to-human match.
- BugLens ([2504.11711](https://arxiv.org/abs/2504.11711)) took precision from 0.10 to 0.72 at
  recall 1.0.

### 5.3 Phase 1: LLM alone vs LLM + opendrs (~$38)

**Commits.** The same 800 seeded test commits the current judge saw, pinned by a sha list, so
every comparison is paired. Arm 3 also needs the first 400 of the seeded training commits, judged
with arm 1's prompt, to fit the combined model.

**Model.** Sonnet 5 at effort `low` with the full diff (60,000 characters), as in the cached run.

| Arm | What runs | Cost (batched) |
|---|---|---|
| **1. LLM alone (L)** | The findings prompt (5.5) on all 800 test commits. No opendrs input. It reports findings (P0–P3, trigger, confidence), classifies each hunk and gives a risk score | ~$14.0 |
| **2. LLM + opendrs context (O)** | The same prompt, plus a trusted opendrs context block of at most 2,500 characters (5.5), on the same 800. Input grows by about 10 %. The cap is +15 % mean tokens per commit | ~$14.4 |
| **3. opendrs as the decision layer (D)** | L's outputs as opendrs signals in the calibrated model, fitted on L's 400 training commits, plus the gate: `requireSafe` and opendrs's score below the training median | ~$7.0, for the training commits |
| Routing (secondary) | L's replies on opendrs's riskiest 10 / 30 / 50 %; the rest takes the fast path | $0, from L |
| Pilot | 30 test commits, L and O, standard API | ~$2.2 |

**Rankings compared.**
- L and O each rank by their own outputs: the count of findings at P0–P2 with confidence ≥ 0.5,
  ties broken by the risk.
- D ranks by the calibrated model, with `llm.findings` (`log1p` of that count),
  `llm.findings.high` (1 when any P0/P1 finding has confidence ≥ 0.8), `llm.semantic` and
  `llm.risk.*`.
- A commit is flagged when it falls inside the review budget.

**Metrics, for every arm:**
- AUC;
- recall, precision and false-positive rate at review budgets of 10 % and 30 %;
- LLM tokens per bug caught, from the measured `response.usage`;
- for L and O, the share of commits with a P0/P1 finding that turn out buggy;
- for D and L, the gate: share auto-approved and buggy rate among them, with Wilson intervals.

**Hypotheses.** H1 and H2 are confirmatory, Holm-corrected at α = 0.05; everything else is
descriptive.
- **H1, the decision layer.** D beats L.
  - Test: the paired bootstrap 95 % CI of AUC(D) − AUC(L) lies above 0.
  - Success: the point estimate is at least +0.02. The cached simulation shows +0.035 to +0.052.
  - D costs no extra LLM tokens per test commit, so any gain in bugs caught at a fixed budget is a
    gain in tokens per bug.
- **H2, context.** O beats L by enough to pay for its extra tokens.
  - Test: the paired bootstrap 95 % CI of AUC(O) − AUC(L) lies above 0.
  - Success: O's LLM tokens per bug caught at a 30 % budget are no higher than L's.
- **H3 (descriptive), independence.** The Spearman correlation between each arm's finding count
  and opendrs's score, for L and for O. A much higher value for O means the context made the LLM
  copy opendrs. A D built on O's outputs would then gain less than one built on L's.

**Decision.**
- If H1 holds, the recommended setup is the LLM plus opendrs as its decision layer.
- If H2 also holds, opendrs's context goes into the judge prompt too.
- If H1 fails, the cached result was a sample artefact, and we say so in the experiment log.

### 5.4 Later, outside this budget

- **Arm 3 with O's outputs.** Needs O on the 400 training commits, about $7.2.
- **A cheap review of every commit.** Haiku 4.5 with the diff cut to 12,000 characters, about $3.
- **The verify pass (R3) and a gate on verified P0/P1 findings (R2).** About $8.6, verifying each
  finding with `/code-review`'s 0–100 rubric, conclusion first.

Each needs its own pre-registration and budget.

### 5.5 Prompt and schema changes (draft)

**Findings prompt (arms 1 and 2).** Insert this into the judge's system prompt before "Hunk
classification":

> Findings: list the concrete defects this change introduces, at most 5, most severe first. A
> finding must (a) point at a changed line inside a [hunk N], (b) name its trigger: the input,
> state or caller that makes it fail, (c) be introduced by this change, not present before it, and
> (d) be something the author would fix if told. Do not report style, naming, missing tests or
> documentation, anything a compiler, type checker or linter would catch, symbols that may be
> defined outside the diff, or speculation that another part of the code might break unless you
> name that code. Priority: P0 = breaks for every input (crash, data loss, security hole); P1 =
> breaks for a plausible input or state; P2 = an edge case or degraded behaviour; P3 = minor.
> Confidence (0 to 1) is the probability that the finding is real. Most changes have no
> findings; return an empty list when nothing qualifies.

Also change the hunk rules: "A risk category `logic_bug`, `security` or `performance` needs a
finding on that hunk; without one, choose a safe category, or `complex`. Use `structural` only
for new modules, public interfaces, data flow or schema."

**Schema.** Add `findings: [{hunk: integer, priority: 0..3, confidence: 0..1, trigger: string ≤
200, description: string ≤ 300}]` (at most 5 items) and drop `risky_snippets`. `parse.ts` maps
each finding to a risky snippet at its hunk's file and line, so reports still show evidence.

**The opendrs context block (arm 2).** It is computed by opendrs from git and sent after the diff,
at most 2,500 characters. The format is below; the values are illustrative:

```
<opendrs_context>
Risk score 0.62 (yellow; 81st percentile of this repository's history).
Top contributions: size.churn +0.41 (412 lines in 9 files), history.prior_fixes +0.33 (6 fixes in
90 days), blast.dependents +0.21 (37 files depend on the changed files), ...
Files:
- broker/src/main/java/.../Queue.java: 37 dependents, exported symbols changed; 4 prior fixes, 1 revert
- ...
Focus first on: [hunk 3], [hunk 7], [hunk 12] (the files with the most dependents and prior fixes).
</opendrs_context>
```

Commit subjects from history are author-written. When quoted, they go inside
`<untrusted_history>`.

Add this to the system prompt:

> opendrs context is a deterministic model's view of where this change is risky. Use it to decide
> where to look first. It is not evidence that a defect exists: report a finding only when the
> diff shows it, and do not raise your risk because the score is high.

### 5.6 Budget

Estimates per call (validated by the pilot):

| Call | Per commit, standard | Per commit, batched |
|---|---:|---:|
| Sonnet 5, findings prompt (L) | ~$0.035 (the current $0.032, plus ~300 output tokens) | ~$0.0175 |
| Sonnet 5, findings prompt with context (O) | ~$0.036 (~+500 input tokens) | ~$0.018 |

| Item | Spend cap (`--max-usd`) | Estimate |
|---|---:|---:|
| Pilot: 30 commits, L and O, standard API | $3 | $2.2 |
| Arm 1 (L) on 800 test commits | $15 | $14.0 |
| Arm 2 (O) on 800 test commits | $16 | $14.4 |
| L on 400 training commits, for arm 3's fit | $8 | $7.0 |
| **Total** | **$42** | **$37.6** |

The headroom is about 12 % under $43. If the pilot measures more than 10 % above these estimates,
the training set shrinks to 300 commits, then O to 600 test commits, before anything else runs.
Without batch support the plan does not fit, and the Batches API is a prerequisite.

### 5.7 Prerequisites ($0) and stop rules

**Prerequisites, all before any spend:**
1. `bench/apachejit/llm.ts`:
   - submission through the Message Batches API;
   - `response.usage` saved with each judgement;
   - a flag that adds the context block for arm 2.
2. Pin the sample with a committed sha list. Today it depends on which row-cache file is newest.
3. The findings schema and prompt, the context block builder (from opendrs's own `Signal`
   evidence), and the new signals, each behind a new prompt hash.
4. Re-clone the 14 projects: diffs are read from the clones (~15 GB, hours, $0).
5. `judge-sim.ts` reads the new caches and prints every headline table.

**Stop rules:**
- **Pilot.** Stop and revise (logged as a new pre-registration) if any of these hold:
  - more than 1 of 30 replies fail the schema;
  - L costs more than $0.045 a commit;
  - O's input is more than 20 % above L's on the same commits;
  - L reports a finding on more than 85 % of commits;
  - more than 5 % of findings cite a missing hunk.
- **Main runs.** Each arm has its own `--max-usd` cap. A batch whose first 200 results show more
  than 2 % failures is cancelled.
- **No tuning on the test sample.** No prompt changes after test results are seen. Any re-run is
  a new, separately logged experiment.

### 5.8 Open questions and risks

- **Commit labels, not bug locations.** ApacheJIT labels commits by SZZ, so "flagged a buggy
  commit" does not mean "found its bug". Finding-level precision is unmeasured. A hand check of
  about 50 P0/P1 findings against the fixing commits would help; it costs time, not money.
- **The free simulation is post hoc.** The decision-layer gain and the snippet signal were
  measured on the same 800 test commits used to look for them. Phase 1 re-tests them with an
  independent prompt and fit.
- **Unequal training data.** LLM + opendrs is fitted on only 400–800 judged training commits.
  opendrs alone uses 41,967. More judged training commits would likely help arm 3.
- **Anchoring in arm 2.** The context may make the LLM agree with opendrs. H3 measures that.
- **Effort stays `low`.** Sonnet 5 runs at effort `low` to pair with the cached run. Findings might
  need more effort.
- **Pretraining contamination.** Apache code is likely in the models' pretraining data, as the
  DRS-OSS authors note. The same applies to every arm.
- **The fast path misses bugs.** Routing and the gate auto-approve commits without an LLM call or
  a human, and the bugs among them are missed. Both report them.

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

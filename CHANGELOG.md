# Changelog

All notable changes to opendrs. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

- New `/opendrs-review` Claude Code plugin command, a "Brief before you review" section in the
  agent skill, and [docs/llm-reviewers.md](docs/llm-reviewers.md): recipes for claude-code-action,
  Cursor Bugbot, CodeRabbit's `path_instructions`, and the generic "paste the brief" pattern for
  GitHub Copilot and Codex.
- `calibrate` refits its chosen setting on every labelled commit. It still chooses the penalty,
  decides whether to keep the priors, and measures its held-out `metrics` on an 80 / 20 time split.
  Earlier versions saved the oldest-80 % fit, which never saw the newest fifth of the history. On
  ApacheJIT, pooled calibrated AUC goes from 0.819 to 0.823 (Kamei LR: 0.821), and recall@10/30 %
  from 29.1 / 66.1 % to 29.7 / 66.8 %. When the priors are kept, nothing changes.
- `trainedOn` in the model file now covers every commit the saved weights were fitted on.
  Right after `calibrate`, `backtest` has no newer commits to test on, so it shows calibrate's
  recorded held-out evaluation as a `calibrated (recorded)` row (`recorded` in `--json`), with a note.
- Bench: `bench/apachejit/run.ts --cached-only` re-fits from the row cache without cloning or
  replaying. `bench/apachejit/fit-experiment.ts` compares fit variants on the cached rows.
- Research note: [how AI code reviewers judge PR risk](docs/research/2026-10-18-review-risk-heuristics.md).
- [Experiment log](docs/experiments.md): every benchmark and model experiment with its numbers and verdict, the
  ones that did not work included (Kamei features, review-heuristic signals).
- The Action's PR comment now leads with a **Review focus** (up to 3 bullets: where to look first,
  the top check question, and any hard-rule reason) and a collapsed "Review brief for AI reviewers"
  section, built deterministically from signals already computed (no extra LLM call). The old
  signal table, unknowns, policy reasons and LLM block move into a collapsed "Score details"
  section — expand it, or read the Action's outputs, if you scrape the table. Set the new `brief`
  input to `false` for the old layout: identical except that control, format (invisible/bidi) and
  tilde-fence characters in untrusted text are now neutralised.
- New Action outputs `brief` (the brief as Markdown) and `brief-file` (its JSON, under
  `$RUNNER_TEMP`); both empty when `brief: false`. The brief is also included in the job summary.
- New `opendrs brief` CLI command and `review_brief` MCP tool: the same token-budgeted review
  brief (where to look first, what to check, what is safe to skim, what still needs a human), for
  a terminal or an agent instead of the Action. `opendrs backtest --brief` reports its (free,
  report-only) focus hit rate. Budget is `brief.maxTokens` in `.opendrs.yml` (default 2500, min
  300, max 6000; see [docs/configuration.md](docs/configuration.md)). A budget below 300 — too
  small for the brief's mandatory sections — is rejected with a clear error from the config,
  `--max-tokens` and the MCP tool's `maxTokens` alike.

## 0.2.0 - 2026-10-18

The roadmap release: Meta's RADAR funnel and the rest of the DRS lineage. Every new policy is off
by default, so moving from `@v0` changes no decision until you configure it. To use the landing
delay or a hold added after approval, add `labeled, unlabeled` to the workflow's
`pull_request` types (see [docs/github-action.md](docs/github-action.md)).

- Labels opendrs adds are created with colours (`risk:green` green, `risk:yellow` yellow,
  `risk:red` red, and the `opendrs:*` labels); a label still in GitHub's default grey is
  recoloured, one you coloured is left alone.

- `opendrs feedback` records an incident in `.opendrs/incidents.jsonl`, by commit
  (`--inducing`, `--fix`) or by PR number (`--pr <n> --was-incident`).
- `opendrs hotspots` (and the MCP tool `list_hotspots`) ranks files by risk at rest, after Meta's
  metrics-driven reengineering work: ranks by fixes, churn, dependents and critical paths; shows authors.
- Reviewer recommendation: for yellow and red PRs, authors of earlier fixes and reverts in the
  changed files rank higher, and the Action requests a review from one of the top three experts
  (picked per PR) instead of a team.
- The Anthropic LLM judge uses structured outputs, so its reply always has the expected shape.

- Deferred review and landing delay, after Meta's RADAR (both off by default).
  `autoApprove.deferredReview` adds the decision `deferred-review`: a PR just above green that
  passes every other rule is approved and lands now, with a post-merge review requested and the
  label `opendrs:review-after-merge`. `autoApprove.landingDelayMinutes` (and
  `sources.<kind>.landingDelayMinutes`) make an eligible PR wait on the same head commit before
  opendrs approves it, labelled `opendrs:landing`; `opendrs:hold`, a change request or a push stops
  it. A `schedule` or `workflow_dispatch` run of the Action re-checks waiting PRs.

- Authorship and per-source policy, after Meta's RADAR: every PR is classified as human, bot or AI
  agent (Claude Code, Copilot coding agent, Cursor, Codex, Devin, Jules, Aider, or
  `sources.agent.patterns`) from commit trailers, author emails and, in CI, the GitHub account
  type. `sources.<kind>` can set a stricter `green`, `requireSafe`, a `dailyCap` on landed commits
  and a `trackRecord` (landed commits and revert rate over N days). These only tighten the gate.
  The source appears in the comment, the terminal output and `--json`.

- Structured LLM judge, after Meta's RADAR: the judge classifies every hunk into a named safe or
  risk category with a 0-10 confidence. Each risk category is a new ranking signal
  (`llm.risk.*`, weights never negative). With `llm.requireSafe: true`, auto-approval also requires
  every hunk the judge saw to be safe at `llm.minConfidence` (default 8), with nothing truncated or
  left unclassified. A reply in the old single-probability format now counts as a judge failure.

- Results on the ApacheJIT benchmark (15 Apache Java projects, official 2017–2019 test years):
  calibrated opendrs reaches AUC 0.819, on par with a regression on the classic JIT metrics. See
  [docs/calibration.md](docs/calibration.md#results-on-apachejit). `bench/apachejit/` reproduces
  it; it is not part of the published package.
- `replayHistory` (library) takes an optional `head` ref and an optional `labels` map, which
  replays exactly those commits with those labels instead of labelling history itself.

## 0.1.5 - 2026-10-16

- Metadata for the official MCP registry entry `io.github.error-path/opendrs`: the npm package
  now carries the matching `mcpName`, and `server.json` describes how to start the server
  (`npx -y @error-path/opendrs mcp`).

## 0.1.4 - 2026-10-16

- Published to npm as [`@error-path/opendrs`](https://www.npmjs.com/package/@error-path/opendrs).
  npm refuses the unscoped name `opendrs` as too close to an existing package. Run the CLI with
  `npx @error-path/opendrs score` and the MCP server with `npx -y @error-path/opendrs mcp`; the
  command it installs is still `opendrs`. `npx github:error-path/opendrs` keeps working.
- Fixed: `blast.public_surface` evidence reported line numbers one too low after a blank context
  line that git printed without its leading space (`diff.suppressBlankEmpty`). The diff walkers in
  the blast, content-block and SZZ code now share one helper that counts hunk lines the way the
  diff parser does.

Ideas from Meta's DRS paper (arXiv 2410.06351) and its RADAR auto-review funnel (arXiv 2605.30208).

- New signal `size.comment_only` (prior weight -2.0). It is 1 when every added or deleted line is
  blank or a plain comment in the file's own syntax, and no file is renamed or binary. A lone `/*`
  or `*/` (which can switch code on or off), a directive comment (`//go:embed`, `// @ts-nocheck`,
  `# type: ignore`, a shebang) and any line in a language without a known comment syntax count as
  code. Meta notes that a comment-only change "has
  no risk" even on a risky path. A calibrated model gives the signal no weight until you run
  `opendrs calibrate` again.
- `freezes`: windows of weekdays and/or dates in a timezone. While one is active, auto-approval is
  suspended, or held to a stricter `green` (Meta's weekend gate and "code chill"). Tiers and labels
  do not change.
- `content.block`: regexes checked against every added line. A match sends the PR to a human, and
  the reason names `file:line` (RADAR's blocklisted code phrases).
- The Action never auto-approves a draft PR, or a PR where a reviewer's latest review requests
  changes.
- When a green PR's earlier approval is withdrawn, for example by a freeze or a sample, the
  dismissal message names the rule instead of "Risk increased".

## 0.1.3 - 2026-10-16

- `opendrs calibrate` keeps the default priors when the fitted weights do not beat them on a
  validation slice inside the training window, and says so. On small or noisy histories, such as
  sinatra in our benchmark, a fitted model ranked held-out commits worse than the defaults. The
  model file records the choice and both validation AUCs under `calibration`.
- `opendrs calibrate` and `opendrs backtest` leave out commits newer than
  `history.labelHorizonDays` (default 60) before the newest replayed commit, from fitting and
  from evaluation. Their bugs are mostly not found yet, so their negative labels are unreliable:
  in our benchmarks the newest 20 % of commits ranked near random (AUC 0.45 to 0.50 on tokio,
  terraform and eslint). Both commands report how many commits were left out.
  `--label-horizon-days <n>` overrides the setting for one run; `0` restores the old behaviour.

## 0.1.2 - 2026-10-16

- The Action's display name is now "opendrs Diff Risk Score", so it can be listed on the GitHub
  Marketplace. GitHub reserves a Marketplace name that matches an existing account, and an
  `OpenDRS` organization exists. Nothing changes for users: keep `uses: error-path/opendrs@v0`.

## 0.1.1 - 2026-10-15

### Breaking

- The Action approves only when the base branch requires an approval and dismisses stale
  approvals on push (an active branch ruleset, or classic protection the token can read).
  Otherwise it logs a warning and does not approve. Add the ruleset described in
  docs/github-action.md, "Required: dismiss stale approvals on push".
- `autoApprove.requireAiReview.labels` is removed. A label is not tied to a commit and anyone with
  triage access can add one, so a self-applied `ai-reviewed` label could get a PR auto-approved.
  A config that still lists it, even as `labels: []`, now fails to parse; list your AI reviewer's
  check run under `requireAiReview.checks` instead. The Action no longer removes AI-review labels
  on `synchronize`.
- A `paths.block` or `paths.critical` list in `.opendrs.yml` now extends the defaults instead of
  replacing them. Setting `block: ["infra/**"]` used to drop every default block, so a
  `postinstall` hook in `package.json` could be auto-approved. To remove a default block glob, list
  it under the new `paths.unblock`, exactly as written in the defaults; any other entry is a
  config error that names the valid ones. If you copied the default list to delete entries from
  it, move those entries to `paths.unblock`. `paths.ignore` and `paths.tests` still replace their
  defaults.

### Security

- Submodule changes are never auto-approved. A moved gitlink (mode 160000) scored as a one-line
  text change, so pointing a submodule at another commit could be auto-approved. The diff parser
  now marks such files (`ChangedFile.submodule`), the gate sends them to a human, and the diff is
  generated so that git config and `.gitmodules` `ignore` settings cannot hide them.
  `.gitmodules` is blocked by default and by the Action's self-modification guard.
- Binary detection no longer relies on git's heuristic or on the PR's own `.gitattributes`. A PR
  that added `tools/* diff` plus an executable, or a jar with 8 KB of text in front, scored as
  text and could be auto-approved. Now:
  - every changed file is read at the head, and one with a NUL anywhere or invalid UTF-8 is
    binary, so it goes to a human;
  - with git 2.40 or later, attributes are read from the base commit (`--attr-source`). Older git
    ignores the global and system attribute files but still reads in-tree ones;
  - `**/.gitattributes` is blocked by default and by the self-modification guard.
- The default `paths.block` now lists files that execute code on install, build or CI: package
  manifests and registry settings (npm, Yarn, pnpm, pip, setuptools), Gradle, Maven, Cargo, Go,
  Bundler and Rake files, Makefiles, Dockerfiles and Compose files, and the GitLab, Jenkins,
  CircleCI, Azure Pipelines and Buildkite pipelines. An `.npmrc` registry change or a `postinstall`
  hook in `package.json` used to score as a tiny change and could be auto-approved. `opendrs init`
  writes the same list. A `paths.block` you set now adds to this list (see Breaking).
- `paths.block`, `paths.critical` and the Action's self-modification guard match ignoring case.
  `makefile` and EF Core `Migrations/` folders slipped past `**/Makefile` and `**/migrations/**`
  and were auto-approved.
- The default `paths.block` also covers Python (`requirements*.txt`, `conftest.py`,
  `.pre-commit-config.yaml`, `tox.ini`, `noxfile.py`), .NET (`*.csproj`, `*.sln`,
  `Directory.Build.*`, `nuget.config`), CMake, `.cargo/`, `.husky/`, GNU make (`GNUmakefile`,
  `*.mk`), `compose.yaml` and `docker-compose*.yaml`, Brewfile, Vagrantfile, Procfile, Nix,
  `.devcontainer/`, `.envrc`, Taskfile, justfile, Bitbucket, Drone, Travis, Cloud Build, Earthly
  and Bazel files, and Rails (`migrate/`) and Flyway (`migration/`) migrations. Each of these
  could be changed in a PR that was auto-approved.
- Deleting tests no longer lowers risk. Deleted test lines counted as test changes, so deleting a
  CSRF check together with its tests scored 0.16 and was auto-approved. Now:
  - `tests.missing` counts only added test lines;
  - a new signal, `tests.deleted`, is 1 when a PR deletes a test file (or renames one out of
    `paths.tests`) or deletes at least 10 more test lines than it adds. Its prior weight is 1.0;
  - such a PR always goes to a human, whatever its score.
- A path containing a line break could dodge every block glob, including `.github/**`, because
  `**` did not match across line breaks. Globs now match any character, and a PR whose paths contain
  control characters always goes to a human.
- The Action's log can no longer be fed workflow commands. A changed file named
  `docs/x\n::stop-commands::…\n::notice::…` was printed verbatim in the decision reasons, so the
  runner executed the commands. Every plain log line now shows line breaks as `⏎` and gets a
  visible `›` before a leading `::` or a legacy `##[`; the Action's own `::group::`, `::warning::`,
  `::notice::` and `::error::` commands still %-escape their message.
- The PR comment and job summary escape untrusted text (file paths, signal summaries, policy
  reasons, the auto-approval line, LLM rationale): `&`, `<`, `>`, `|`, backticks, brackets and
  backslashes are escaped and line breaks removed, so a file name cannot break the table or inject
  HTML or links. File names and reviewers in inline code have backticks replaced by `ˋ`.
- The Action warns when drift sampling is predictable. With `autoApprove.enabled`, a
  `sampleRate` above 0 and no `sample-salt`, anyone can compute which PR numbers get sampled
  (`acme/app#107` is, `#108` is not). It now logs "sampling is predictable; set sample-salt to a
  secret" and repeats it in the PR comment; docs/github-action.md, "Set sample-salt", shows how.

### Added

- `autoApprove.requireAiReview.checks` entries can be `{ name, app }`, where `app` is the slug of
  the GitHub App that must have published the check run (for example `coderabbitai` or
  `github-actions`). A check was matched by name only, and any workflow or app can publish a check
  run under any name; a pinned check now ignores same-named runs from other apps. Plain names work
  as before. For checks from GitHub Actions, give the reviewer job a unique name: see
  docs/github-action.md, "Pin a check to the app that publishes it".

## 0.1.0 - 2026-10-15

First release.

- `opendrs score`, `explain`, `calibrate`, `backtest`, `init` and `mcp`.
- Signals from git history modelled on Meta's DRS: size, diffusion, prior fixes and incidents,
  author expertise, complexity, language. Also blast radius from an import graph, critical and
  blocked paths, missing tests, and an optional LLM judge that can only raise risk.
- Logistic model with hand-set priors. Calibration on your own history, from reverts, SZZ and
  incidents.
- GitHub Action with comment, labels and optional auto-approve plus merge queue, behind these
  rails:
  - config read from the base branch;
  - a self-modification guard;
  - author verification;
  - approvals pinned to the scored commit;
  - withdrawal on risk increase or error.

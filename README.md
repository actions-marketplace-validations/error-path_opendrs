# opendrs: PR blast radius analyzer and risk score for safe auto-approval

**A calibrated 0-1 risk score for every pull request, so AI-reviewed, low-blast-radius PRs can be
auto-approved into the merge queue while risky ones still wait for a human.**

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-opendrs%20Diff%20Risk%20Score-2ea44f?logo=github)](https://github.com/marketplace/actions/opendrs-diff-risk-score)
[![CI](https://github.com/error-path/opendrs/actions/workflows/ci.yml/badge.svg)](https://github.com/error-path/opendrs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AI agents now write and review code faster than people can read it, so human review has become
the bottleneck. Most pull requests are low risk, and a few cause most incidents. opendrs measures
each PR's **blast radius** and risk: what the change touches, how many files depend on it, the
history of the files it changes, author experience, missing tests and critical paths. It turns
that into a 0-1 score using signals from your own git history. A team then sets a policy.
For example, a PR that scores below 0.3 and has passed an AI review (Claude, CodeRabbit, Copilot
or any check run) is approved and sent to the merge queue or auto-merge. Riskier PRs still wait
for a human. The approach follows Meta's Diff Risk Score (DRS); opendrs is an independent,
open-source implementation that runs in any git repository, with no service to host.

Use it as:

- **a GitHub Action**: [`error-path/opendrs@v0`](https://github.com/marketplace/actions/opendrs-diff-risk-score), which comments, labels and, optionally, approves and merges;
- **a CLI**: `npx github:error-path/opendrs score`;
- **a Claude Code plugin** (skill plus MCP server): `/plugin marketplace add error-path/opendrs`, then `/plugin install opendrs@opendrs`;
- **an agent skill** for Claude Code, Cursor, Codex and others: `npx skills add error-path/opendrs`;
- **an MCP server** for any agent: `npx -y github:error-path/opendrs mcp`.

## Quick start

Score your current branch against the default branch. No configuration or API key is needed:

```sh
npx github:error-path/opendrs score
```

You get a score, a tier (green, yellow or red), the signals that drove it with their evidence,
and the policy decision. `--json` prints the full result, and `--fail-above 0.6` makes the
command exit 1 above a threshold.

To score every pull request, add `.github/workflows/opendrs.yml` (or run `npx github:error-path/opendrs init`):

```yaml
name: opendrs
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  checks: read
jobs:
  opendrs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0   # required: the score reads past commits and authors
      - uses: error-path/opendrs@v0
```

This only comments and labels. Approval is off until you turn it on in `.opendrs.yml` on your
default branch; see [docs/github-action.md](docs/github-action.md).

## How it works

```mermaid
flowchart LR
  diff["git diff<br/>merge-base...head"] --> signals
  hist["git history"] --> signals
  graph["import graph"] --> signals
  llm["LLM judge<br/>(optional)"] --> signals
  signals["Signals<br/>each with evidence<br/>and provenance"] --> model["Logistic model<br/>score = sigmoid(b + Σ w·x)"]
  model --> tier["Tier<br/>green / yellow / red"]
  tier --> policy["Policy<br/>blocks, size cap, unknowns,<br/>AI review, sampling"]
  policy --> decision["auto-approve<br/>waiting-ai-review<br/>human-review"]
```

1. **Signals.** Each signal provider reads the diff, the history and the import graph and emits
   features: size, how spread out the change is, past fixes and reverts in the touched files,
   the author's experience with them, complexity, blast radius (transitive dependents), critical
   paths and missing tests. Every signal records how it was obtained (`observed`, `derived`,
   `inferred` or `unknown`) and the evidence behind it.
2. **Model.** A logistic regression turns the features into a probability. Each signal's
   contribution `w·x` is reported, so you can see why a PR scored what it did. Out of the box the
   weights are hand-set priors; `opendrs calibrate` fits them to your repository.
3. **Tiers.** The score maps to green, yellow or red, mirroring Meta's gates. Thresholds can be
   absolute scores or percentiles of your own history.
4. **Policy.** Ordered rules turn the score into a decision (see [below](#policy-and-safety-rails)).

## Meta's DRS features and their opendrs signals

Meta's baseline is a logistic regression over about a dozen features, chosen from about 100
([paper](https://arxiv.org/abs/2410.06351)). opendrs computes each one from git alone:

| Meta DRS feature | opendrs signal | How it is computed |
|---|---|---|
| Log of added/deleted lines relative to file size | `size.churn`, `size.relative` | `log1p` of changed lines, and of changed lines over base file length; lockfiles, generated and vendored files excluded |
| Diff creates new files only | `size.new_files_only` | 1 when every changed file is new |
| Log of number of files | `diffusion.files`, `diffusion.dirs` | `log1p` of changed files and of distinct top-level directories |
| Log of distinct authors of the changed files | `diffusion.authors` | `log1p` of distinct authors in the files' history |
| Previous SEV in the file or folder | `history.incident`, `history.prior_fixes` | a recorded incident or revert touched the file or folder; `log1p` of fix and revert commits in the lookback window |
| High-criticality service | `paths.critical` | changed file matches `paths.critical` globs |
| Total logical complexity | `complexity.touched` | `log1p` of branch keywords in the touched files (language-agnostic heuristic) |
| Language indicators | `lang.*` | one indicator per language family present |
| Author created the file | `expertise.owner_ratio` | share of changed files the author created or mostly wrote |
| Author's landed diffs | `expertise.author_commits` | `log1p` of the author's prior commits; negative weight |
| Test plan | `tests.missing` | 1 when source changed and no test lines were added; otherwise `max(0, 1 − addedTestLines / (0.3 · sourceLines))` (a proxy). Deleted test lines never count |
| (not in Meta's list) | `tests.deleted` | 1 when a test file is deleted (or renamed out of `paths.tests`), or 10 or more test lines more are deleted than added. Also a policy rule: such a PR always goes to a human |
| LLM risk model (iDiffLlama) | `llm.semantic` | `max(0, logit(p) − logit(0.2))` from an optional prompted LLM judge: it can only raise risk |
| (not in Meta's list) | `blast.dependents`, `blast.public_surface` | transitive dependents of the changed files (depth 3) from the import graph; exported symbols changed in a file that has dependents |
| (not in Meta's list) | `history.churn` | `log1p` of commits touching the files in the lookback window |

The import graph uses regex-based extractors for TypeScript/JavaScript, Python, Go, Java/Kotlin,
Rust and Ruby. Files in other languages get `unknown` blast-radius signals, which the policy
treats as risk, not as zero.

## Policy and safety rails

The decision rules run in this order; the first that matches wins:

1. a changed file matches `paths.block` → `human-review` (hard block);
2. a changed file is ignored (`paths.ignore`), binary, or a submodule pointer (gitlink), or the PR
   deletes tests (`tests.deleted`) → `human-review`;
3. more than `maxChangedLines` changed → `human-review`;
4. tier is not green → `human-review`;
5. the LLM judge failed, or the `unknown` signals, all at their worst at once, could have changed
   the tier → `human-review`;
6. a required AI-review check has not passed on the head commit → `waiting-ai-review`;
7. the PR is sampled for human review → `human-review`;
8. otherwise `auto-approve`.

The decision also suggests three reviewers: the most frequent recent authors of the changed files.

The rails that matter when the Action can approve PRs:

- **Config comes from the base branch.** The Action reads `.opendrs.yml` and the calibrated model
  from the PR's base commit, so a PR cannot loosen its own gate.
- **Hard blocks.** `paths.block` (by default `.github/**`, `.opendrs.yml`, `.opendrs/**`,
  `CODEOWNERS`, migrations, Terraform, `.gitmodules`, `.gitattributes`, and files that execute
  code on install, build or CI; see [Configuration](#configuration)) always sends the PR to a
  human.
- **Binary files cannot pass as text.** Git's own test only looks for a NUL in the first 8000 bytes
  and obeys `.gitattributes`, so opendrs also reads every changed file at the PR head and treats it
  as binary when it holds a NUL anywhere or is not valid UTF-8. With git 2.40 or later the diff
  reads attributes from the base commit (`--attr-source`), so the PR's own `.gitattributes` has no
  effect. Older git ignores only the global and system attribute files and still reads the ones in
  the checkout; the content check above still catches binaries there.
- **Submodules.** Moving a submodule pointer pulls in code the diff does not show, so any gitlink
  change goes to a human, whatever `diff.submodule`, `diff.ignoreSubmodules` or a submodule's
  `ignore` setting says. Repointing a submodule's URL changes `.gitmodules`, which is blocked.
- **Self-modification guard.** Independently of any config, the Action never approves a PR that
  adds, changes, deletes or renames `.opendrs.yml`, `.opendrs/**`, `.github/**`, `action.yml`,
  `action/**`, `.gitmodules` or any `.gitattributes`, or the configured model file. It also never approves PRs from forks.
- **Sampling.** `sampleRate` (default 10 %) of eligible PRs still go to a human, chosen
  deterministically from the head commit, so you keep measuring what the gate lets through.
- **Unknown is not safe.** A signal that cannot be computed is reported under "Unknowns" and blocks
  auto-approval when it could have changed the tier. A failed or unparseable LLM answer counts the
  same way.
- **Withdrawn approvals.** When a new push makes the PR ineligible, the Action dismisses its own
  earlier approval ("Risk increased: yellow 0.45").
- **Stale approvals are blocked by branch rules.** The Action approves only if the base branch
  requires at least one approval and dismisses stale approvals on push. Without that rule, an
  approval for one commit could carry over to a later, riskier push. See
  [docs/github-action.md](docs/github-action.md) for the ruleset.
- **Prompt injection.** The diff, PR title and PR body are untrusted. The LLM prompt wraps them in
  delimiters and tells the model to ignore instructions inside them; the PR body is not sent at
  all unless `llm.includeDescription` is true. The answer must be exactly one JSON object and is
  clamped to [0, 1]. The judge can only raise the score, never lower it, so talking it into
  "risk 0" gains nothing. Risk claims written in the PR text never change the score directly.

## Calibrate and backtest: measure your threshold

The default weights are priors. Before you let the score approve anything, measure it on your own
history:

```sh
npx github:error-path/opendrs backtest     # how well do the default priors rank your past commits?
npx github:error-path/opendrs calibrate    # fit weights to your history, write .opendrs/model.json
npx github:error-path/opendrs backtest     # compare default and calibrated models
```

The backtest replays past commits point-in-time (each commit sees only the history before it) and
reports Meta's metric: the share of incident-linked commits captured when you gate the riskiest
5 %, 10 % and 50 % of commits, plus ROC-AUC. Incident-linked commits come from reverts,
SZZ-blamed bug fixes and an optional `.opendrs/incidents.jsonl`. See
[docs/calibration.md](docs/calibration.md) for the label sources and how to read the numbers.

For orientation only: Meta reports that its LR baseline captured 18.7 %, 27.9 % and 84.6 % of SEVs
at 5 %, 10 % and 50 % gated. Those are Meta's in-house results on its own code and incident data,
not numbers your repository should be expected to match.

## Results on public repositories

We ran `opendrs calibrate` and then `opendrs backtest --max-commits 4000` on nine open-source
repositories with opendrs v0.1.0, without changing any configuration. Labels come from reverts and
SZZ blame on fix commits only, since none of these repos publish an incident list. Read them as
"later needed a fix", not as production incidents.

**Held-out commits** are the commits newer than the calibration window, and so unseen by the fitted
model. That is the fair comparison between the default priors and a calibrated model:

| Repository | Language | Commits | Positives | AUC: default priors (held-out) | AUC: calibrated (held-out) | Caught in riskiest 10 %: default, all commits |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| [expressjs/express](https://github.com/expressjs/express) | JavaScript | 4,000 | 628 | 0.62 | **0.73** | 17.8 % |
| [pallets/flask](https://github.com/pallets/flask) | Python | 3,828 | 793 | 0.75 | **0.78** | 12.5 % |
| [django/django](https://github.com/django/django) | Python | 4,000 | 1,102 | 0.63 | **0.70** | 19.6 % |
| [gin-gonic/gin](https://github.com/gin-gonic/gin) | Go | 1,806 | 380 | 0.63 | **0.67** | 15.0 % |
| [prometheus/prometheus](https://github.com/prometheus/prometheus) | Go | 4,000 | 619 | 0.59 | **0.62** | 24.7 % |
| [rust-lang/cargo](https://github.com/rust-lang/cargo) | Rust | 4,000 | 1,163 | 0.61 | **0.75** | 15.2 % |
| [spring-projects/spring-boot](https://github.com/spring-projects/spring-boot) | Java | 4,000 | 152 | 0.61 | **0.62** | 32.9 % |
| [quarkusio/quarkus](https://github.com/quarkusio/quarkus) | Java | 6,000 | 497 | 0.65 | **0.66** | 28.2 % |
| [rails/rails](https://github.com/rails/rails) | Ruby | 4,000 | 351 | 0.63 | **0.71** | 17.9 % |

What this shows:

- **Calibration beat the default priors on held-out commits in all nine repositories.** The median
  AUC gain is +0.04, but on spring-boot and quarkus the gain is too small to matter. Fit the
  model on your own history; don't rely on the defaults.
- The default priors alone rank risk better than chance everywhere. Their AUC over all replayed
  commits ranges from 0.58 to 0.70. On quarkus, gating the riskiest 5 % and 10 % caught 18.5 % and
  28.2 % of positives. For orientation only, Meta reports 18.7 % and 27.9 % for its internal
  logistic-regression baseline. Different code, labels and population make this an analogy, not a
  comparison.
- Positive rates range from 4 % (spring-boot) to 29 % (cargo). SZZ labels are noisy, and a project's
  fix-commit habits shape them. Your own incident list (`.opendrs/incidents.jsonl`) is the
  strongest label you can add.
- Two known approximations, both reported by `backtest`: the import graph comes from the newest
  commit, and the newest commits' labels are incomplete.

### A broader run: 18 more repositories

Both runs used opendrs 0.1.2, before the label horizon (`history.labelHorizonDays`) existed. Re-running with it should mostly change the held-out column, by leaving out commits too new to have been fixed yet.

A second, shorter run used the newest 1,200–1,500 commits of each of 18 more repositories, again
without any configuration. "Caught" is the share of later-fixed commits that fall in the riskiest
10 % of commits; a random ranking catches 10 %.

| Repository | Positives | Default: caught / AUC (all commits) | Held-out AUC: default → calibrated |
| --- | ---: | ---: | ---: |
| [tiangolo/fastapi](https://github.com/tiangolo/fastapi) | 29 | 44.8 % / 0.78 | 0.73 → 0.70 |
| [ktorio/ktor](https://github.com/ktorio/ktor) | 261 | 26.4 % / 0.78 | 0.77 → **0.84** |
| [square/okhttp](https://github.com/square/okhttp) | 82 | 31.7 % / 0.76 | 0.66 → **0.70** |
| [hashicorp/terraform](https://github.com/hashicorp/terraform) | 96 | 36.5 % / 0.75 | 0.48 → 0.50 |
| [alacritty/alacritty](https://github.com/alacritty/alacritty) | 462 | 20.6 % / 0.74 | 0.69 → **0.76** |
| [eslint/eslint](https://github.com/eslint/eslint) | 119 | 31.1 % / 0.74 | 0.48 → 0.40 |
| [python-poetry/poetry](https://github.com/python-poetry/poetry) | 372 | 23.9 % / 0.73 | 0.71 → **0.79** |
| [laravel/framework](https://github.com/laravel/framework) | 58 | 31.0 % / 0.72 | 0.73 → 0.71 |
| [celery/celery](https://github.com/celery/celery) | 144 | 26.4 % / 0.72 | 0.77 → **0.81** |
| [prettier/prettier](https://github.com/prettier/prettier) | 86 | 25.6 % / 0.71 | 0.71 → **0.85** |
| [gohugoio/hugo](https://github.com/gohugoio/hugo) | 180 | 23.9 % / 0.69 | 0.64 → **0.72** |
| [sveltejs/svelte](https://github.com/sveltejs/svelte) | 325 | 21.2 % / 0.69 | 0.63 → **0.66** |
| [pydantic/pydantic](https://github.com/pydantic/pydantic) | 156 | 23.1 % / 0.68 | 0.79 → 0.77 |
| [tokio-rs/tokio](https://github.com/tokio-rs/tokio) | 87 | 40.2 % / 0.68 | 0.45 → 0.45 |
| [psf/requests](https://github.com/psf/requests) | 104 | 23.1 % / 0.67 | 0.79 → 0.71 |
| [etcd-io/etcd](https://github.com/etcd-io/etcd) | 127 | 22.8 % / 0.65 | 0.63 → **0.76** |
| [sinatra/sinatra](https://github.com/sinatra/sinatra) | 229 | 15.3 % / 0.60 | 0.59 → 0.56 |
| [serde-rs/serde](https://github.com/serde-rs/serde) | 92 | 15.2 % / 0.51 | 0.50 → **0.63** |

What this adds:

- **Untuned, the score ranks risk better than chance in 17 of 18 repositories.** The median AUC
  over all replayed commits is 0.71, and the riskiest 10 % of commits hold 15–45 % of the
  later-fixed ones, against 10 % for a random pick. serde (0.51) is the exception.
- **Calibration helped in 11, was flat in 1 and hurt in 6.** Small held-out windows make these
  numbers noisy: fastapi and laravel have fewer than 15 positives in theirs. Since this run,
  `calibrate` keeps the default priors when the fitted weights do not beat them on a validation
  slice of your own history. Either way, run `backtest` before you trust a threshold.
- Held-out AUCs near 0.45–0.50 (tokio, terraform, eslint) come from the newest commits, whose
  bugs mostly haven't been found and fixed yet. Expect labels there to be incomplete.

Reproduce a row: `git clone <repo> && cd <repo> && npx github:error-path/opendrs calibrate --max-commits 4000 && npx github:error-path/opendrs backtest --max-commits 4000`.
Runs took 1 to 16 minutes per repository on a 4-core Linux machine.

## LLM judge (optional)

opendrs works without an LLM. With one, a prompted model reads the title and diff and returns a
probability of incident `p`; it enters the model as one more signal (`llm.semantic`, prior weight
0.8) with the value `max(0, logit(p) − logit(0.2))`. The judge can only add risk above a 0.2
baseline: an answer of 0.2 or less adds nothing, and no answer can lower the score. A diff that
someone talks the judge into calling safe therefore scores exactly as it would without an LLM.
The reply must contain exactly one JSON object. When the diff exceeds `maxDiffChars`, every file
first gets its first hunk and only then do larger files get more, and truncated files are marked.

```yaml
llm:
  enabled: true
  provider: anthropic        # reads ANTHROPIC_API_KEY
  model: claude-sonnet-5
```

For OpenAI or any OpenAI-compatible server (Azure OpenAI, Ollama, vLLM), set `provider: openai`,
`model`, and `baseUrl`; the key is read from `OPENAI_API_KEY`, or from the variable named in
`apiKeyEnv`. In the Action, pass the key as the `llm-api-key` input. The diff is sent to the
provider you configure. If the call fails, the signal is `unknown`, and the PR cannot be
auto-approved on that run.

## MCP server and agent skill

`opendrs mcp` runs a Model Context Protocol server on stdio, so coding agents can check risk
before they open a PR. It exposes `score_diff` (base, head, cwd), `explain_file_risk` (path) and
`suggest_reviewers` (paths). For Claude Code:

```sh
claude mcp add opendrs -- npx -y opendrs mcp
```

Other clients take the same command: `{"command": "npx", "args": ["-y", "opendrs", "mcp"]}`.

The agent skill in [`skills/opendrs/SKILL.md`](skills/opendrs/SKILL.md) tells an agent to run
`opendrs score` before opening a PR and to split changes with a large blast radius.

## CLI

| Command | What it does |
|---|---|
| `opendrs score [--base ref] [--head ref] [--json \| --markdown] [--fail-above x] [--no-llm] [--title t]` | Score `merge-base(base, head)..head`. Base defaults to `origin/HEAD`, then `main`, then `master`. |
| `opendrs explain <file> [--json]` | A file's history, fixes, authors, dependents and path policy. |
| `opendrs calibrate [--since date] [--max-commits n] [--label-horizon-days n]` | Fit the model and write it to `config.model`. |
| `opendrs backtest [--since date] [--max-commits n] [--label-horizon-days n] [--json]` | Compare default and calibrated models on your history. |
| `opendrs init [--force]` | Write a commented `.opendrs.yml` and a comment-only workflow. |
| `opendrs mcp` | Run the MCP server. |

Exit codes: 0 success, 1 score above `--fail-above`, 2 error. Set `OPENDRS_DEBUG=1` for stack traces.

## Configuration

All keys are optional. This is the full file with every default (`opendrs init` writes it):

```yaml
thresholds:
  mode: absolute        # absolute: scores in 0..1; percentile: percentiles of your
                        # calibrated history (e.g. green: 50, yellow: 90, red: 95)
  green: 0.3            # below green: eligible for auto-approval
  yellow: 0.6
  red: 0.8

autoApprove:
  enabled: false        # false = comment and label only (dry run)
  requireAiReview:      # every listed check must have passed on the PR's head commit
    checks: []          # check-run names that must have concluded success, e.g. ["claude-review"]
  mergeMethod: queue    # queue | auto-merge | none
  sampleRate: 0.1       # share of eligible PRs still routed to a human
  maxChangedLines: 400  # never auto-approve above this, whatever the score

paths:
  # block and critical are matched ignoring case, and a list you set adds to these defaults.
  block: [".github/**", ".opendrs.yml", ".opendrs/**", "**/CODEOWNERS",
          "**/migrations/**", "**/migration/**", "**/migrate/**", "**/*.tf",
          ".gitmodules", "**/.gitattributes",
          # files that execute code on install, build or CI
          "**/package.json", "**/.npmrc", "**/.yarnrc", "**/.yarnrc.yml", "**/.pnpmfile.cjs",
          "**/setup.py", "**/setup.cfg", "**/pyproject.toml", "**/pip.conf",
          "**/build.gradle", "**/build.gradle.kts", "**/settings.gradle*", "**/gradle/wrapper/**",
          "**/pom.xml", "**/.mvn/**",
          "**/Cargo.toml", "**/build.rs", "**/go.mod",
          "**/Gemfile", "**/Rakefile", "**/*.gemspec",
          "**/requirements*.txt", "**/conftest.py", "**/.pre-commit-config.y*ml", "**/tox.ini",
          "**/noxfile.py",
          "**/*.csproj", "**/*.sln", "**/Directory.Build.*", "**/nuget.config",
          "**/CMakeLists.txt", "**/*.cmake", "**/.cargo/**", "**/.husky/**",
          "**/Makefile", "**/GNUmakefile", "**/*.mk",
          "**/Dockerfile*", "**/docker-compose*.y*ml", "**/compose.y*ml",
          "**/Brewfile", "**/Vagrantfile", "**/Procfile", "**/*.nix", "**/flake.lock",
          "**/.devcontainer/**", "**/.envrc", "**/Taskfile.y*ml", "**/justfile",
          ".gitlab-ci.yml", "Jenkinsfile", ".circleci/**", "azure-pipelines.yml", ".buildkite/**",
          "**/bitbucket-pipelines.yml", "**/.drone.yml", "**/.travis.yml", "**/cloudbuild.y*ml",
          "**/Earthfile", "**/BUILD", "**/BUILD.bazel", "**/WORKSPACE*", "**/MODULE.bazel", "**/*.bzl"]
  unblock: []           # default block globs to drop, written exactly as above, e.g. ["**/go.mod"]
  critical: ["**/auth/**", "**/payment*/**", "**/billing/**", "**/security/**"]
  # ignore and tests: a list you set replaces the default.
  # Scored as no risk (a lockfile bump stays green) but never auto-approved, like binary files.
  ignore: ["**/*.lock", "**/package-lock.json", "**/pnpm-lock.yaml", "**/go.sum", "**/dist/**",
           "**/vendor/**", "**/node_modules/**", "**/*.min.js", "**/*.snap"]
  tests: ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*",
          "**/*_test.*", "**/test_*.py"]

llm:
  enabled: false
  provider: anthropic   # anthropic | openai (any OpenAI-compatible endpoint)
  model: claude-sonnet-5
  # baseUrl: https://api.openai.com/v1
  # apiKeyEnv: MY_KEY_VAR
  includeDescription: false   # the PR body is untrusted; title only by default
  maxDiffChars: 60000

history:
  lookbackDays: 365
  fixPattern: "\\b(fix(es|ed)?|bug|hotfix|regression|incident|sev\\d?|revert)\\b"
  maxCommits: 20000
  labelHorizonDays: 60   # calibrate/backtest skip the newest 60 days: their bugs may not be found yet (0 = off)

graph:
  enabled: true
  maxDepth: 3
  maxFiles: 50000

model: .opendrs/model.json   # written by `opendrs calibrate`; priors are used until it exists
```

**Why the default block list is long.** Besides the gate's own files, `paths.block` lists
files that execute code on install, build or CI: package manifests and their registry settings
(`package.json`, `.npmrc`, `setup.py`, `pyproject.toml`, `requirements.txt`, ...), build scripts
and project files (`build.gradle`, `pom.xml`, `build.rs`, `Makefile`, `CMakeLists.txt`, `*.csproj`,
`Dockerfile`, Bazel and Nix files, ...), developer hooks and environments (`.husky/`,
`.pre-commit-config.yaml`, `conftest.py`, `.envrc`, `.devcontainer/`, ...) and CI pipelines outside
`.github/`. Block and critical globs are matched ignoring case, so `makefile` or an EF Core
`Migrations/` folder cannot slip past `**/Makefile` or `**/migrations/**`. A
one-line change there (a `postinstall` hook, a registry pointed at another host, a new build
step) scores as small and low-risk, but runs on every developer machine and CI runner. Dependency
bumps also change a lockfile, which is in `paths.ignore` and so already goes to a human.

**Your lists add to the defaults.** A `paths.block` or `paths.critical` you set extends the
default list; it never replaces it, so `block: ["infra/**"]` blocks `infra/**` as well as
everything above. To drop a default block entry, name it under `paths.unblock` on the default
branch, written exactly as in the list, for example `unblock: ["**/go.mod"]` if you trust `go.mod`
edits to code review alone. An `unblock` entry that is not a default block glob is a config error
that lists the valid ones, so a typo cannot pass silently. `paths.unblock` wins over the same glob
under `paths.block`. Default `critical` globs cannot be removed. `paths.ignore` and `paths.tests`
work the other way: a list you set replaces the default. In the Action, the self-modification
guard keeps `.github/**`, `.opendrs.yml`, `.opendrs/**`, the action, `.gitmodules` and
`.gitattributes` blocked whatever the lists say.

opendrs refuses a config that would fail silently, naming the offending value:

- **Globs** are repo-relative and support `**`, `*`, `?` and `{a,b}`. A glob with `[` or `]`
  (character classes are not supported), a backslash, or a leading `/` or `./` is an error.
- **`paths.unblock`** entries must each be a default `paths.block` glob, character for character.
- **Thresholds** must be ordered: `0 ≤ green < yellow ≤ red ≤ 1` in absolute mode, and
  `0 < green < yellow ≤ red < 100` in percentile mode.

## Limitations

- **The default weights are not fit to your code.** They are priors chosen to rank obvious cases
  sensibly. Run `backtest` before trusting them, and `calibrate` when you have enough history.
- **Labels are proxies.** Reverts and SZZ-blamed fixes are noisy stand-ins for incidents: SZZ
  blames refactors and formatting, and many incidents are fixed by config changes or never touch
  git. `.opendrs/incidents.jsonl` improves this only as far as you keep it current.
- **Small repositories give unstable numbers.** With a few dozen positive commits, calibrated
  weights and capture rates swing widely between runs.
- **The import graph is regex-based.** It misses dynamic imports, reflection, dependency
  injection, code generation, and dependencies across services or repositories.
- **Complexity is a heuristic** that counts branch keywords; it does not parse code.
- **Test signals count lines, not assertions.** `tests.missing` and `tests.deleted` see only files
  matching `paths.tests`. A PR that weakens a test without shrinking it (an assertion edited into a
  no-op) is not flagged by them, and tests outside those globs are not seen at all. Splitting a test
  file into new ones counts as deleting a test file and goes to a human.
- **The LLM judge is prompted, not trained.** Meta's LLM variants were fine-tuned on Meta's own
  incidents; a general model reading a diff is a weaker signal, and it costs money per PR.
- **The score is not a code review.** It estimates the chance of an incident, not whether the
  change is correct. Auto-approval still depends on your tests and your AI reviewer.
- **Required checks are matched by name.** opendrs does not verify which app produced a check run,
  so protect the names you list (see [docs/github-action.md](docs/github-action.md)).
- **GitHub only.** The core is host-agnostic, but only a GitHub Action exists today. The Action
  needs full history (`fetch-depth: 0`). In a shallow clone, `diffusion.authors` and `history.*`
  are reported as `unknown` ("shallow clone: history incomplete"), keeping what they saw as a lower
  bound, so a missing history never reads as low risk.

## Prior art and credits

- **Meta's Diff Risk Score.** [Diff Risk Score: AI-driven risk-aware software development](https://engineering.fb.com/2025/08/06/developer-tools/diff-risk-score-drs-ai-risk-aware-software-development-meta/)
  (Engineering at Meta, 2025) and Abreu et al., [Moving Faster and Reducing Risk: Using LLMs in
  Release Deployment](https://arxiv.org/abs/2410.06351) (2024). The feature set, the tiered gates and
  the capture-at-X %-gated metric come from this work. opendrs is not affiliated with Meta.
- **Just-in-time defect prediction and SZZ.** Mockus and Weiss, "Predicting risk of software
  changes" (2000); Śliwerski, Zimmermann and Zeller, "When do changes induce fixes?" (2005); Kamei
  et al., "A large-scale empirical study of just-in-time quality assurance" (2013). The
  change-level features and the SZZ-style labelling follow this literature.
- **REA** ([morluto/rea](https://github.com/morluto/rea)). opendrs adopts REA's evidence-first
  method: every conclusion is marked observed, derived, inferred or unknown, and unknown is never
  treated as safe. It also follows REA's layering of domain types, providers, a shared engine and
  thin adapters.

## License

[MIT](LICENSE)

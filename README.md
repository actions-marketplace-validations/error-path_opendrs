# opendrs

**Open Diff Risk Score: a calibrated 0-1 risk score for every pull request.**

AI agents now write and review code faster than people can read it, so human review has become
the bottleneck. Most pull requests are low risk, and a few cause most incidents. opendrs scores
each PR by how likely it is to cause an incident, using signals from your own git history. A team
then sets a policy: for example, a PR that scores below 0.3 and has passed an AI review is
approved and sent to the merge queue, while riskier PRs still wait for a human. The idea comes
from Meta's Diff Risk Score (DRS); opendrs is an independent, open-source implementation that runs
in any git repository, with no service to host.

## Quick start

Score your current branch against the default branch. No configuration or API key is needed:

```sh
npx opendrs score
```

You get a score, a tier (green, yellow or red), the signals that drove it with their evidence,
and the policy decision. `--json` prints the full result, and `--fail-above 0.6` makes the
command exit 1 above a threshold.

To score every pull request, add `.github/workflows/opendrs.yml` (or run `npx opendrs init`):

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
| Test plan | `tests.missing` | 1 when source changed and no test file did (a proxy) |
| LLM risk model (iDiffLlama) | `llm.semantic` | `max(0, logit(p) − logit(0.2))` from an optional prompted LLM judge: it can only raise risk |
| (not in Meta's list) | `blast.dependents`, `blast.public_surface` | transitive dependents of the changed files (depth 3) from the import graph; exported symbols changed in a file that has dependents |
| (not in Meta's list) | `history.churn` | `log1p` of commits touching the files in the lookback window |

The import graph uses regex-based extractors for TypeScript/JavaScript, Python, Go, Java/Kotlin,
Rust and Ruby. Files in other languages get `unknown` blast-radius signals, which the policy
treats as risk, not as zero.

## Policy and safety rails

The decision rules run in this order; the first that matches wins:

1. a changed file matches `paths.block` → `human-review` (hard block);
2. a changed file is ignored (`paths.ignore`) or binary → `human-review`;
3. more than `maxChangedLines` changed → `human-review`;
4. tier is not green → `human-review`;
5. the LLM judge failed, or the `unknown` signals, all at their worst at once, could have changed
   the tier → `human-review`;
6. the required AI-review checks or labels are missing → `waiting-ai-review`;
7. the PR is sampled for human review → `human-review`;
8. otherwise `auto-approve`.

The decision also suggests three reviewers: the most frequent recent authors of the changed files.

The rails that matter when the Action can approve PRs:

- **Config comes from the base branch.** The Action reads `.opendrs.yml` and the calibrated model
  from the PR's base commit, so a PR cannot loosen its own gate.
- **Hard blocks.** `paths.block` (by default `.github/**`, `.opendrs.yml`, `.opendrs/**`,
  `CODEOWNERS`, migrations and Terraform) always sends the PR to a human.
- **Self-modification guard.** Independently of any config, the Action never approves a PR that
  adds, changes, deletes or renames `.opendrs.yml`, `.opendrs/**`, `.github/**`, `action.yml` or
  `action/**`, or the configured model file. It also never approves PRs from forks.
- **Sampling.** `sampleRate` (default 10 %) of eligible PRs still go to a human, chosen
  deterministically from the head commit, so you keep measuring what the gate lets through.
- **Unknown is not safe.** A signal that cannot be computed is reported under "Unknowns" and blocks
  auto-approval when it could have changed the tier. A failed or unparseable LLM answer counts the
  same way.
- **Withdrawn approvals.** When a new push makes the PR ineligible, the Action dismisses its own
  earlier approval ("Risk increased: yellow 0.45").
- **Prompt injection.** The diff, PR title and PR body are untrusted. The LLM prompt wraps them in
  delimiters and tells the model to ignore instructions inside them; the PR body is not sent at
  all unless `llm.includeDescription` is true. The answer must be exactly one JSON object and is
  clamped to [0, 1]. The judge can only raise the score, never lower it, so talking it into
  "risk 0" gains nothing. Risk claims written in the PR text never change the score directly.

## Calibrate and backtest: measure your threshold

The default weights are priors. Before you let the score approve anything, measure it on your own
history:

```sh
npx opendrs backtest     # how well do the default priors rank your past commits?
npx opendrs calibrate    # fit weights to your history, write .opendrs/model.json
npx opendrs backtest     # compare default and calibrated models
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

Backtest results on public repos: coming soon.

<!-- results -->

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
| `opendrs calibrate [--since date] [--max-commits n]` | Fit the model and write it to `config.model`. |
| `opendrs backtest [--since date] [--max-commits n] [--json]` | Compare default and calibrated models on your history. |
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
  requireAiReview:      # every listed check and label must be present
    checks: []          # check-run names that must have concluded success, e.g. ["claude-review"]
    labels: []          # labels that must be on the PR, e.g. ["ai-reviewed"]
  mergeMethod: queue    # queue | auto-merge | none
  sampleRate: 0.1       # share of eligible PRs still routed to a human
  maxChangedLines: 400  # never auto-approve above this, whatever the score

paths:
  block: [".github/**", ".opendrs.yml", ".opendrs/**", "**/CODEOWNERS", "**/migrations/**", "**/*.tf"]
  critical: ["**/auth/**", "**/payment*/**", "**/billing/**", "**/security/**"]
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

graph:
  enabled: true
  maxDepth: 3
  maxFiles: 50000

model: .opendrs/model.json   # written by `opendrs calibrate`; priors are used until it exists
```

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

// Files written by `opendrs init`. CONFIG_TEMPLATE must parse to exactly defaultConfig()
// (tests/cli/init-mcp.test.ts checks this), so editing a default means editing both.

export const CONFIG_TEMPLATE = `# opendrs configuration. Every value below is the default; delete what you do not change.
# In the GitHub Action this file is read from the PR's BASE commit, so a PR cannot loosen
# its own gate. Reference: https://github.com/error-path/opendrs#configuration

# Score cut-offs for the tiers (Meta's DRS gates: green / yellow / red).
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
  sampleRate: 0.1       # share of eligible PRs still routed to a human, to detect drift
  maxChangedLines: 400  # never auto-approve above this, whatever the score

paths:
  # Hard block: a PR touching any of these always needs a human. Matched ignoring case.
  block:
    - ".github/**"
    - ".opendrs.yml"
    - ".opendrs/**"
    - "**/CODEOWNERS"
    - "**/migrations/**"
    - "**/migration/**"
    - "**/migrate/**"
    - "**/*.tf"
    - ".gitmodules"
    - "**/.gitattributes"
    # Files that execute code on install, build or CI. Dependency bumps also change a lockfile,
    # which is ignored and so goes to a human anyway. To let a PR that touches one of these be
    # auto-approved, delete its line here, deliberately.
    - "**/package.json"
    - "**/.npmrc"
    - "**/.yarnrc"
    - "**/.yarnrc.yml"
    - "**/.pnpmfile.cjs"
    - "**/setup.py"
    - "**/setup.cfg"
    - "**/pyproject.toml"
    - "**/pip.conf"
    - "**/build.gradle"
    - "**/build.gradle.kts"
    - "**/settings.gradle*"
    - "**/gradle/wrapper/**"
    - "**/pom.xml"
    - "**/.mvn/**"
    - "**/Cargo.toml"
    - "**/build.rs"
    - "**/go.mod"
    - "**/Gemfile"
    - "**/Rakefile"
    - "**/*.gemspec"
    - "**/requirements*.txt"
    - "**/conftest.py"
    - "**/.pre-commit-config.y*ml"
    - "**/tox.ini"
    - "**/noxfile.py"
    - "**/*.csproj"
    - "**/*.sln"
    - "**/Directory.Build.*"
    - "**/nuget.config"
    - "**/CMakeLists.txt"
    - "**/*.cmake"
    - "**/.cargo/**"
    - "**/.husky/**"
    - "**/Makefile"
    - "**/GNUmakefile"
    - "**/*.mk"
    - "**/Dockerfile*"
    - "**/docker-compose*.y*ml"
    - "**/compose.y*ml"
    - "**/Brewfile"
    - "**/Vagrantfile"
    - "**/Procfile"
    - "**/*.nix"
    - "**/flake.lock"
    - "**/.devcontainer/**"
    - "**/.envrc"
    - "**/Taskfile.y*ml"
    - "**/justfile"
    - ".gitlab-ci.yml"
    - "Jenkinsfile"
    - ".circleci/**"
    - "azure-pipelines.yml"
    - ".buildkite/**"
    - "**/bitbucket-pipelines.yml"
    - "**/.drone.yml"
    - "**/.travis.yml"
    - "**/cloudbuild.y*ml"
    - "**/Earthfile"
    - "**/BUILD"
    - "**/BUILD.bazel"
    - "**/WORKSPACE*"
    - "**/MODULE.bazel"
    - "**/*.bzl"
  # Raises the score (Meta's "high-criticality service" feature). Matched ignoring case.
  critical:
    - "**/auth/**"
    - "**/payment*/**"
    - "**/billing/**"
    - "**/security/**"
  # Excluded from size and churn (lockfiles, generated and vendored code); never auto-approved.
  ignore:
    - "**/*.lock"
    - "**/package-lock.json"
    - "**/pnpm-lock.yaml"
    - "**/go.sum"
    - "**/dist/**"
    - "**/vendor/**"
    - "**/node_modules/**"
    - "**/*.min.js"
    - "**/*.snap"
  # Files that count as tests for the "source changed without tests" signal.
  tests:
    - "**/test/**"
    - "**/tests/**"
    - "**/__tests__/**"
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/*_test.*"
    - "**/test_*.py"

# Optional LLM judge, one extra signal. The diff and PR text are treated as untrusted.
llm:
  enabled: false
  provider: anthropic   # anthropic | openai (any OpenAI-compatible endpoint)
  model: claude-sonnet-5
  # baseUrl: https://api.openai.com/v1   # for OpenAI-compatible servers (Azure, Ollama, vLLM)
  # apiKeyEnv: MY_KEY_VAR                # default: ANTHROPIC_API_KEY or OPENAI_API_KEY
  includeDescription: false   # the PR body is untrusted; the title only by default
  maxDiffChars: 60000

history:
  lookbackDays: 365
  fixPattern: "\\\\b(fix(es|ed)?|bug|hotfix|regression|incident|sev\\\\d?|revert)\\\\b"
  maxCommits: 20000

# Reverse import graph used for blast radius.
graph:
  enabled: true
  maxDepth: 3
  maxFiles: 50000

# Calibrated model written by \`opendrs calibrate\`; the default priors are used until it exists.
model: .opendrs/model.json
`;

export const WORKFLOW_TEMPLATE = `# opendrs: comment a risk score on every pull request.
# Comment-only until you set autoApprove.enabled in .opendrs.yml on the default branch.
# Docs: https://github.com/error-path/opendrs/blob/main/docs/github-action.md
name: opendrs

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

# A newer push cancels the run for the older head, so it cannot approve or merge a stale commit.
concurrency:
  group: opendrs-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

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
          fetch-depth: 0   # full history: the score uses past commits and authors
      - uses: error-path/opendrs@v0
        id: opendrs
        # with:
        #   llm-api-key: \${{ secrets.ANTHROPIC_API_KEY }}   # only used when llm.enabled
`;

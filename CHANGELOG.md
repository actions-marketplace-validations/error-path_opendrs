# Changelog

All notable changes to opendrs. Versions follow [Semantic Versioning](https://semver.org/).

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
  writes the same list. If your `.opendrs.yml` sets its own `paths.block`, it replaces the defaults:
  compare it with the new list.
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

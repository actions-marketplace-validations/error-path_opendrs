# Changelog

All notable changes to opendrs. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Security

- Submodule changes are never auto-approved. A moved gitlink (mode 160000) scored as a one-line
  text change, so pointing a submodule at another commit could be auto-approved. The diff parser
  now marks such files (`ChangedFile.submodule`), the gate sends them to a human, and the diff is
  generated so that git config and `.gitmodules` `ignore` settings cannot hide them.
  `.gitmodules` is blocked by default and by the Action's self-modification guard.

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

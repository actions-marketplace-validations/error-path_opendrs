# Changelog

All notable changes to opendrs. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Breaking

- The Action approves only when the base branch requires an approval and dismisses stale
  approvals on push (an active branch ruleset, or classic protection the token can read).
  Otherwise it logs a warning and does not approve. Add the ruleset described in
  docs/github-action.md, "Required: dismiss stale approvals on push".

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

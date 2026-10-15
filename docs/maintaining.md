# Maintaining opendrs

A short runbook for the maintainer.

## Weekly (about 15 minutes)

1. **Pull requests.** Dependabot opens grouped PRs for npm and GitHub Actions updates. If CI is
   green, merge them. For an Action update, check its release notes first.
2. **Issues.** Label each new issue `bug`, `enhancement` or `question`, and reply within a week.
   Close an issue that has no reproduction after 14 days without an answer.
3. **Security tab.** Check for private vulnerability reports and Dependabot alerts.

## Merging a contribution

- CI (`check (22)`, `check (24)`) must pass; the `main` ruleset enforces it.
- When `src/` changes, the PR must also include a rebuilt `action/dist`. CI fails otherwise.
- Read every change to `src/action/`, `src/policy/` or `.github/workflows/` line by line. These are
  the approval rails. A bug there lets someone merge code without review in every repo that uses
  opendrs.
- Prefer squash merges, so `main` reads as one commit per change.

## Releasing

1. Update `version` in `package.json` and `src/version.ts`, and add a section to `CHANGELOG.md`.
2. Merge that PR.
3. Tag the release and move the major tag (from a network that allows pushes):

   ```sh
   git checkout main && git pull
   git tag v0.2.0 && git tag -f v0
   git push origin v0.2.0 && git push -f origin v0
   ```

4. Create a GitHub release from the tag with the changelog section as notes.
5. Optionally, publish to npm with `npm publish` (the `prepack` script builds `dist`).

Users pin `@v0`, so moving `v0` ships the release to them. Never move `v0` to a version with a
breaking change; release `v1` instead.

## Handling a security report

1. Acknowledge it within 7 days in the private advisory thread.
2. Reproduce it with a test. Fix it in a private fork from the advisory, or a normal PR if the
   report is already public.
3. Release a patch, move `v0`, publish the advisory, and credit the reporter.

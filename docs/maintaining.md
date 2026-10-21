---
title: "Maintaining opendrs"
description: "The maintainer runbook for opendrs: weekly triage, releases and security."
---

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
5. Publish to npm from the tag with `npm publish`. The package is `@error-path/opendrs`;
   `publishConfig` makes it public, and the `prepack` script builds `dist`.
6. Update the MCP registry entry: set both `version` fields in `server.json` to the release
   (do this in step 1), then run `mcp-publisher login github` and `mcp-publisher publish` from
   the tag. The registry checks that the npm package's `mcpName` matches `server.json`'s `name`,
   so publish to npm first.

Users pin `@v0`, so moving `v0` ships the release to them. Never move `v0` to a version with a
breaking change; release `v1` instead.

## Docs site

The site in `docs/` is built and deployed by the `pages` workflow, using Jekyll 4.4 (see
`docs/Gemfile`). It needs no secrets. Every run:

1. builds the site and runs `scripts/check-site.mjs`, which fails on a broken internal link, a
   missing or duplicate title or description, more than one `<h1>`, a page no other page links
   to, a sitemap entry without `lastmod`, invalid JSON-LD or a broken `llms.txt` link. Pull
   requests that touch `docs/` run the same build and check, without deploying;
2. deploys to GitHub Pages;
3. sends IndexNow the pages that were added, changed (new `lastmod`) or removed, by comparing the
   live sitemap with the new one.

To tell Bing about URLs by hand, such as pages removed outside a deploy, run the workflow from the
Actions tab and paste them into `extra_urls`, separated by spaces. The IndexNow key is the file
`docs/7761d20ca5295159e2dd2f14ffccbe2b.txt` and `KEY` in `.github/workflows/pages.yml`. To rotate
it, replace both. To preview locally: `cd docs && bundle install && bundle exec jekyll serve`.

## Handling a security report

1. Acknowledge it within 7 days in the private advisory thread.
2. Reproduce it with a test. Fix it in a private fork from the advisory, or a normal PR if the
   report is already public.
3. Release a patch, move `v0`, publish the advisory, and credit the reporter.

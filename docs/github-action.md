# The opendrs GitHub Action

The Action scores each pull request, upserts one PR comment, sets a `risk:green`,
`risk:yellow` or `risk:red` label, writes the job summary, and sets the outputs `score`, `tier`
and `decision`. When you enable it, it also approves low-risk PRs and turns on auto-merge or adds
them to the merge queue.

## Minimal workflow (comment-only)

```yaml
name: opendrs
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
concurrency:
  group: opendrs-${{ github.event.pull_request.number }}
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
          fetch-depth: 0
      - uses: error-path/opendrs@v0
        id: opendrs
```

`fetch-depth: 0` is required. opendrs reads past commits (authors, earlier fixes and reverts),
computes the merge-base of the PR, and reads the config from the base commit. With a shallow clone
the job fails with "Base commit ... is not in the checkout".

Keep the `concurrency` block. A push cancels the run still scoring the previous head, so an old
run cannot approve or merge a commit it did not score. The Action also re-reads the PR head before
approving, and passes the scored commit as `expectedHeadOid` when it enables auto-merge or
enqueues, so GitHub refuses to enable either if the head already moved. Neither stops a commit
pushed after the approval from merging on it; that needs the branch ruleset described in
[Required: dismiss stale approvals on push](#required-dismiss-stale-approvals-on-push).

Run it on `pull_request`, never on `pull_request_target`. A `pull_request_target` run uses the
base branch's workflow with a write token and the repository's secrets, even for fork PRs, and
opendrs checks out and reads the PR's code. opendrs only works on events that carry a
`pull_request` payload; do not add `merge_group` or `push` triggers to this workflow.

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token for the REST and GraphQL APIs. |
| `base-config` | `true` | Read `.opendrs.yml` and the model from the PR's base commit. Leave it on. When `false`, the `llm` section and the `model` path still come from the base commit, so a PR cannot send the LLM key to its own `llm.baseUrl` or export another secret through `llm.apiKeyEnv`. |
| `llm-api-key` | empty | Exported as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `llm.apiKeyEnv`. Used only when `llm.enabled`. |
| `comment` | `true` | Create or update the PR comment (found by the `<!-- opendrs -->` marker). |
| `labels` | `true` | Set the risk label and remove stale ones. |
| `sample-salt` | empty | Set to a secret to make sampling unpredictable, e.g. `${{ secrets.OPENDRS_SAMPLE_SALT }}`. The drift sample (`autoApprove.sampleRate`) is keyed by repository, PR number and this salt, so pushing another commit does not re-roll it. |

| Output | Values |
|---|---|
| `score` | 0 to 1, four decimals |
| `tier` | `green`, `yellow`, `red` |
| `decision` | `auto-approve`, `waiting-ai-review`, `human-review` (the policy decision, even when approval is disabled) |

Use the outputs in later steps, for example to request a reviewer on red PRs:

```yaml
      - if: steps.opendrs.outputs.tier == 'red'
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ github.event.pull_request.number }}
        run: gh pr edit "$PR" --add-reviewer my-org/oncall
```

## Permissions

| Permission | Needed for |
|---|---|
| `contents: read` | checkout |
| `pull-requests: write` | comment, labels, approve, dismiss |
| `checks: read` | reading which AI-review checks passed (`autoApprove.requireAiReview.checks`) |
| `contents: write` | enabling auto-merge or adding to the merge queue |
| `issues: write` | only if the `risk:*` labels do not exist yet and label creation fails with 403 |

When a call returns 403 the Action logs a `::warning::` with the cause and carries on; it fails
the job only on operational errors (scoring, git, invalid config, non-permission API errors).
Before it fails, it dismisses its own approval on the PR and disables auto-merge and the merge queue
entry, so an error never leaves an earlier approval in force.

## Repository settings for auto-approval

1. **Settings > Actions > General > Workflow permissions:** enable *Allow GitHub Actions to create
   and approve pull requests*. Without it the approval returns 403 and the Action logs a warning.
2. **Settings > General > Pull Requests:** enable *Allow auto-merge* if you use
   `mergeMethod: auto-merge`, or as the fallback for `queue`.
3. **A branch ruleset on the base branch that requires one approval and dismisses stale
   approvals (required).** See below. opendrs checks it before every approval and does not
   approve without it. opendrs's approval counts as the required approval.
4. **Recommended:** in the same ruleset, require the status checks you trust (tests, your AI
   review) and the opendrs job's check. opendrs cannot verify which checks you require, because
   a job's check name depends on your workflow.

If you require review from code owners, opendrs cannot satisfy it, because the bot is not a code
owner.

### Required: dismiss stale approvals on push

An approval belongs to a commit, but GitHub keeps it in force after a new push unless the branch
dismisses it. Without that, someone with write access can get commit A approved with auto-merge
on, push commit B, and cancel the opendrs run for B (or merge before it ends): B then merges on
A's approval. The `concurrency` block and the head check do not prevent this, because the run that
would withdraw the approval never finishes.

So before approving, opendrs reads the base branch's rules (`GET /repos/{owner}/{repo}/rules/branches/{branch}`)
and approves only when an active `pull_request` rule requires at least one approval and dismisses
stale approvals on push. Failing that, it accepts classic branch protection with the same two
settings (`GET /repos/{owner}/{repo}/branches/{branch}/protection`). Reading classic protection
needs *Administration: read*, which the default `GITHUB_TOKEN` does not have, so with the default
token only a ruleset can be verified. When neither confirms it, opendrs does not approve, logs a
`::warning::` naming the settings, and says so in the PR comment. A 403 or 404 counts as not
verified.

To set it up:

1. Open **Settings > Rules > Rulesets** and choose **New ruleset > New branch ruleset**.
2. Name it, for example `default branch`, and set **Enforcement status** to **Active**.
3. Under **Target branches**, choose **Add target > Include default branch** (or the branch your
   PRs merge into).
4. Leave **Bypass list** empty, or add only people you would trust to merge without review.
5. Enable **Require a pull request before merging**, and in its options:
   - set **Required approvals** to at least `1`;
   - enable **Dismiss stale pull request approvals when new commits are pushed**.
6. Recommended: enable **Require status checks to pass**, and add your test and AI-review checks
   and the opendrs job's check (named after the job, for example `opendrs`).
7. Click **Create**.

Then re-run the opendrs job or push a commit. The job log line `Not approving: could not confirm that ...`
means the ruleset is missing, inactive, does not target the base branch, or lacks one of the two
settings in step 5.

Events caused by `GITHUB_TOKEN` do not start new workflow runs. If the merge must trigger
workflows (for example a deploy on push to `main`), pass a GitHub App token as `github-token`.

## Merge queue

With `mergeMethod: queue` the Action calls `enqueuePullRequest` when the base branch has a merge
queue, and falls back to `enablePullRequestAutoMerge` (with a notice) when it does not.

To set up a queue: add a branch ruleset for the default branch with *Require merge queue*, and add
`merge_group` to the triggers of the workflows that run your required checks (your CI, not the
opendrs workflow). Give the opendrs job `contents: write`.

If enabling auto-merge or enqueueing fails (for example "Pull request is in clean status", or
auto-merge is not allowed), the approval stays and the Action logs a warning.

## What the Action will never approve

Approval needs all of these:

- `autoApprove.enabled: true` in `.opendrs.yml` **on the base commit**;
- the policy decision is `auto-approve`;
- the PR does not add, change, delete or rename `.opendrs.yml`, `.opendrs/**`, `.github/**`,
  `action.yml`, `action.yaml`, `action/**`, or the configured model file. This guard is in code
  and no configuration turns it off;
- the PR is not from a fork;
- the base branch requires an approval and dismisses stale approvals on push (see
  [Required: dismiss stale approvals on push](#required-dismiss-stale-approvals-on-push)).

When any of these stop holding on a later push, the Action dismisses its own earlier approval and
also disables auto-merge and removes the PR from the merge queue. It identifies its approvals by
the `<!-- opendrs-approval -->` marker and the token's own user (`github-actions` and
`github-actions[bot]` count as the same account; when the token cannot read its own login, any bot
account with the marker counts), and never touches anyone else's review. Auto-merge is only
turned off when opendrs had an approval to withdraw, so auto-merge a person enabled stays on. A
PR that changes the opendrs config, the model or the workflows always needs a human.

### Author identity

The author email on a commit is whatever the PR author typed, so opendrs does not take it on
trust. The Action lists the PR's commits (`GET /pulls/{n}/commits`) and treats the head commit's
author as verified only when GitHub maps its email to the account that opened the PR. Otherwise,
and also when the clone is shallow, the author-expertise signals count as unknown, which usually
routes the PR to a human. Suggested reviewers leave out the emails GitHub has verified for the
PR's author, not the email the head commit claims.

## Pairing with an AI reviewer

opendrs measures risk; it does not review the code. The intended setup is: an AI reviewer checks
correctness, and opendrs decides whether a human must look too. Tell opendrs which check runs
mean "the AI review passed":

```yaml
# .opendrs.yml on the default branch
autoApprove:
  enabled: true
  requireAiReview:
    checks: ["claude-review"]
```

If the AI review has not finished when opendrs runs, the decision is `waiting-ai-review`. The
simplest way to avoid that race is one workflow where opendrs runs after the review job, whose
check run is named after the job:

```yaml
name: review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
concurrency:
  group: opendrs-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  contents: write
  pull-requests: write
  checks: read
jobs:
  claude-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      # Your AI review, for example anthropics/claude-code-action with a review prompt.
      # The job must FAIL when the review finds a blocking problem, so that a
      # successful "claude-review" check means the review passed.
      - run: ./scripts/ai-review.sh
  opendrs:
    needs: claude-review
    if: ${{ !cancelled() }}   # still comment when the review fails
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: error-path/opendrs@v0
```

A check that merely ran is not a passed review: make the review job fail when it finds a blocking
issue. opendrs matches checks by name only and does not verify which app created them. Any
workflow on the PR's head commit can create a check with that name, which is one reason PRs that
change `.github/**` are never approved.

Only check runs count. A check run belongs to one commit, so a new push starts without it. PR
labels are not supported: a label is not tied to a commit, stays on the PR across pushes, and
anyone with triage access can add one. `requireAiReview.labels` was removed in 0.1.1, and a config
that still lists it fails with an error; make your AI reviewer report a check run instead.

## Rollout

1. **Comment-only (default).** Install the workflow with `autoApprove.enabled: false`. For two to
   four weeks, compare the scores with what reviewers actually found and with what was reverted.
2. **Measure.** Run `opendrs backtest`, then `opendrs calibrate` and `backtest` again. Pick
   thresholds from the capture rates (see [calibration.md](calibration.md)), and commit the model
   through a normal reviewed PR.
3. **Approve without merging.** Set `enabled: true`, `mergeMethod: none` and `sampleRate: 0.2`.
   Approvals now appear, people still press merge, and one in five eligible PRs still gets a human.
4. **Merge.** Switch to `mergeMethod: queue` (or `auto-merge`) and lower `sampleRate`, but keep it
   above zero so you keep measuring what the gate lets through.

To roll back, set `autoApprove.enabled: false` on the default branch. On the next run for each
open PR, opendrs dismisses its earlier approval.

## Fork pull requests

On `pull_request` events from forks, GitHub gives the job a read-only token. opendrs still scores
the PR and writes the job summary; the comment and labels fail with 403 and are logged as
warnings. Fork PRs are never approved, whatever the token can do. Do not switch to
`pull_request_target` to get a write token for forks.

## Troubleshooting

| Message | Fix |
|---|---|
| `Base commit ... is not in the checkout` | Set `fetch-depth: 0` on `actions/checkout`. |
| `GitHub refused the approval (403)` | Enable *Allow GitHub Actions to create and approve pull requests*, and grant `pull-requests: write`. |
| `Could not read check runs (403)` | Add `checks: read`. Until then, required AI-review checks count as missing. |
| `Could not write the PR comment (403)` | Add `pull-requests: write`. Expected on fork PRs. |
| `could not confirm that ... dismisses it when new commits are pushed` | Add the branch ruleset from [Required: dismiss stale approvals on push](#required-dismiss-stale-approvals-on-push). |
| `enabling auto-merge failed` | Enable *Allow auto-merge*, grant `contents: write`, or check the branch's merge queue. |
| `opendrs needs a pull_request event` | Run the workflow on `pull_request` only. |

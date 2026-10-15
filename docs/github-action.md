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
enqueues, so GitHub refuses the merge if the head moved.

Run it on `pull_request`, never on `pull_request_target`. A `pull_request_target` run uses the
base branch's workflow with a write token and the repository's secrets, even for fork PRs, and
opendrs checks out and reads the PR's code. opendrs only works on events that carry a
`pull_request` payload; do not add `merge_group` or `push` triggers to this workflow.

## Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `github-token` | `${{ github.token }}` | Token for the REST and GraphQL APIs. |
| `base-config` | `true` | Read `.opendrs.yml` and the model from the PR's base commit. Leave it on. |
| `llm-api-key` | empty | Exported as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `llm.apiKeyEnv`. Used only when `llm.enabled`. |
| `comment` | `true` | Create or update the PR comment (found by the `<!-- opendrs -->` marker). |
| `labels` | `true` | Set the risk label and remove stale ones. |

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
3. **Branch ruleset or protection on the default branch:** require the status checks you trust
   (tests, your AI review) and one approval. opendrs's approval counts as that approval. If you
   require review from code owners, opendrs cannot satisfy it, because the bot is not a code owner.
4. Optionally enable *Dismiss stale pull request approvals when new commits are pushed*. opendrs
   approves a specific commit and re-scores on every push either way.

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
- the PR is not from a fork.

When any of these stop holding on a later push, the Action dismisses its own earlier approval and
also disables auto-merge and removes the PR from the merge queue. It identifies its approvals by
the `<!-- opendrs-approval -->` marker and the token's own user (`github-actions` and
`github-actions[bot]` count as the same account; when the token cannot read its own login, any bot
account with the marker counts), and never touches anyone else's review. Auto-merge is only
turned off when opendrs had an approval to withdraw, so auto-merge a person enabled stays on. A PR that changes the opendrs config, the model or the
workflows always needs a human.

## Pairing with an AI reviewer

opendrs measures risk; it does not review the code. The intended setup is: an AI reviewer checks
correctness, and opendrs decides whether a human must look too. Tell opendrs which checks or
labels mean "the AI review passed":

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

To use a label instead (for example an AI reviewer that adds `ai-reviewed`), list it under
`requireAiReview.labels` and add `labeled` to the opendrs workflow's `pull_request` types, so the
PR is re-scored when the label arrives.

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
| `enabling auto-merge failed` | Enable *Allow auto-merge*, grant `contents: write`, or check the branch's merge queue. |
| `opendrs needs a pull_request event` | Run the workflow on `pull_request` only. |

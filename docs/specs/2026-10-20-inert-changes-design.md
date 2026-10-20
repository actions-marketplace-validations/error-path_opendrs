# Inert changes: docs and comments stop counting toward the size cap

Status: **approved 2026-10-20.** Option A (size-cap-only exemption, no tier forcing, no gate
bypass) was decided by the user in conversation on 2026-10-20; the open questions in §8 were
resolved the same day. See §8 for the resolutions; an implementation plan follows this spec.

## 1. Goal and non-goals

**Goal.** A PR that only changes files or lines which cannot affect running code — Markdown/RST/
text docs, blank lines, plain comments — should not need a human reviewer purely because
`autoApprove.maxChangedLines` counted those lines. Configured folders the user trusts
(`autoApprove.sizeCapExempt`) get the same relief. Markdown that drives agent or CI behaviour
(`CLAUDE.md`, skills, prompts, `.github/**`) must never be treated as inert, whatever its extension.

**Non-goals.**
- No forced green tier: a docs-heavy PR that scores yellow or red for some other reason (e.g. it
  touches `paths.critical`) still goes to a human.
- No gate bypass: every other rule in `docs/policy.md` (`paths.block`, `content.block`,
  `tests.deleted`, unread-files/binary, submodules, control characters, unknowns, source policy,
  sampling, freeze windows, landing delay, draft/changes-requested, AI review) runs unchanged, on
  the full diff. This touches one number — `changedLines` in the size-cap rule — nothing else in
  `src/policy/gate.ts`.
- No change to the score: `size.churn`, `size.relative` and `size.comment_only` keep reading every
  line unfiltered; only the gate's size-cap rule reads the new, smaller count.

## 2. Definition of "inert"

Computed per file, and for comment-only code per hunk, in this order (first match wins):

1. **Instruction files are never inert** (§3) — counts in full, whatever its extension.
2. **Test files are never inert** — matched by `paths.tests`, the same globs the skim list and
   `tests.deleted` already use. The test file is exactly the evidence a human checks that a change
   is safe, so it must always count, even under a broad `sizeCapExempt` glob.
3. **`autoApprove.sizeCapExempt` glob match** — every line of the file is inert.
4. **Docs-family file** (`src/signals/language.ts` `languageFamily(path) === "docs"`: `.md`, `.rst`,
   `.txt`, `.patch`, `.diff`) — every line of the file is inert, the same classification `skim.ts`
   already uses for "safe to skim". Unlike the comment-only check below (which excludes renames for
   code, per `src/signals/size.ts` `commentOnly`), a renamed docs file is still docs.
5. **Comment-only hunk in a code file** — a hunk where every changed (`+`/`-`) line passes the
   existing per-line `inert()` test in `src/signals/size.ts` (blank, or a plain comment in the
   file's own syntax; directives, lone block delimiters and unknown languages are never inert).
   Applied per hunk, not per file, so a file with one real-code hunk and one comment-only hunk only
   excuses the latter. Renamed, binary or textless-diff files are never comment-only, matching
   today's file-level rule.
6. Everything else counts in full.

## 3. Agent-instruction files are never inert

New default list `paths.instructions` (additive, like `paths.block`/`paths.critical` — a config's
own list extends it, there is no `unblock`-style removal):

```
"**/CLAUDE.md", "**/AGENTS.md", "**/GEMINI.md", ".claude/**", ".cursor/**", ".cursorrules",
".windsurfrules", ".github/copilot-instructions.md", ".github/instructions/**", "**/SKILL.md",
"**/*.prompt.md", "**/prompts/**", ".opendrs/**"
```

Only `.opendrs/**` and `.github/**` (covering the two `.github/` entries above) are already in
`DEFAULT_BLOCK` and stay hard-blocked regardless; listing them here keeps the rule true if a repo
`unblock`s one, and lets the captain fact and the size count share one list. The rest — `CLAUDE.md`,
`AGENTS.md`, `GEMINI.md`, `.claude/**`, `.cursor/**`, `*.prompt.md`, `prompts/**` — are new: none
are blocked or specially treated today, and a `CLAUDE.md` edit is plain `languageFamily === "docs"`
— exactly the file the user does not want exempted.

**Precedence:** `paths.instructions` > `paths.tests` > `autoApprove.sizeCapExempt` >
docs-family/comment-only. A `CLAUDE.md` matched by `sizeCapExempt: ["docs/**"]` still counts in
full; it is still `.md` but never treated as docs for this purpose.

**Captain fact.** New strong `ArchitectureFact` id `contract.instructions`, alongside
`contract.schema` in `src/domain/types.ts`: one fact per matched file (cap 3, rest counted, same
convention as `contract.schema`), text "Changes agent instructions: `CLAUDE.md`". The captain
brief (`docs/specs/2026-10-19-captain-brief-design.md`) shipped in 0.4.0, so this ships now as a
real captain fact — registered in `src/architecture` alongside `contract.dependency`/
`contract.api`/`contract.schema`/`contract.env` so detector ordering and fact ranks stay
consistent — not as a placeholder Policy-section note (§8.2).

## 4. Gate change

`src/policy/gate.ts` §2 today computes one number and fires on it:

```ts
const changedLines = diff.files.filter((f) => !f.ignored).reduce((n, f) => n + (f.binary ? 1 : f.added + f.deleted), 0);
if (changedLines > auto.maxChangedLines) {
  fire("human-review", `${changedLines} changed lines exceeds autoApprove.maxChangedLines (${auto.maxChangedLines})`, "size-cap");
}
```

Keep `changedLines` (the raw total — still used for the brief and the comment's "9 files · +310
−22"), and add `countedLines`: the sum of each file's non-inert lines per §2/§3 (`added + deleted`,
or `1` for binary, when not inert; `0` when inert; equal to `changedLines` when
`autoApprove.countInertLines` is true, see §5). Fire on `countedLines`, not `changedLines`:

```ts
if (countedLines > auto.maxChangedLines) {
  const reason = countedLines === changedLines
    ? `${changedLines} changed lines exceeds autoApprove.maxChangedLines (${auto.maxChangedLines})`
    : `${changedLines} changed lines, ${countedLines} counted toward maxChangedLines after excluding ` +
      `${changedLines - countedLines} inert docs/comment lines (cap ${auto.maxChangedLines})`;
  fire("human-review", reason, "size-cap");
}
```

The old one-number sentence survives whenever nothing was excluded, so existing reason-string
expectations keep working. The PR comment's Policy section shows the same two-number sentence.

## 5. Config schema and docs

`src/domain/config.ts`:

```ts
paths: z.object({
  /* ...existing... */
  instructions: globs(DEFAULT_INSTRUCTIONS),   // additive, like block/critical
}).transform((p) => ({ ...p, instructions: union(DEFAULT_INSTRUCTIONS, p.instructions) /* , ...existing unions */ })),

autoApprove: z.object({
  /* ...existing... */
  sizeCapExempt: globs([]),                      // inert for the size cap only (§2.3)
  countInertLines: z.boolean().default(false),   // true: restore pre-0.x behaviour (every line counts)
}),
```

`DEFAULT_INSTRUCTIONS` is a new exported `readonly string[]` next to `DEFAULT_BLOCK`/
`DEFAULT_CRITICAL`. `sizeCapExempt` reuses `globs()` for the same glob validation.

**Backward compatibility.** This is a **default behaviour change**: today every changed line counts
toward `maxChangedLines`; after this ships, docs and comment-only lines stop counting by default.
It only *loosens* the gate — a PR that was eligible stays eligible, every other rule still runs —
but a repo that used the cap as a blunt "keep docs PRs small" policy will see more through.
`countInertLines: true` restores the old count exactly. Recommend the new behaviour as the default
(`countInertLines: false`), called out under a CHANGELOG `### Changed` heading: an opt-in flag
nobody sets would not fix the PR #39-style blocks this spec targets.

**Docs:** `docs/configuration.md` — rows for `paths.instructions` and `autoApprove.sizeCapExempt`/
`countInertLines` in the key table and full-file example, plus an "Inert lines and the size cap"
subsection next to "Why the default block list is long". `docs/policy.md` — reword decision rule 3
("more than `maxChangedLines` *counted* lines") and add a safety-rail row. `docs/auto-approve.md` —
add instruction files to "What is never auto-approved". `CHANGELOG.md` — one Unreleased entry.

## 6. Safety analysis

- **Docs folders with executable content.** This repo's own PR #34 is the real example: it changed
  `docs/_layouts/default.html` and `docs/assets/site.css` — Jekyll/site code under `docs/` that is
  `.html`/`.css`, which `languageFamily` classifies as `"other"`, not `"docs"`. Those lines are
  **not** inert by default; they only become so if the owner explicitly lists them (e.g.
  `sizeCapExempt: ["docs/assets/**"]`) from the base branch — the same trust boundary every other
  `.opendrs.yml` setting has. Same for `.ipynb` notebooks and `_config.yml`/`_layouts/**.html`.
- **A `.md` file can still carry Liquid front matter.** `languageFamily` treats it as docs
  regardless — an existing blind spot shared with `skim.ts`, not a new one; bounded by the fact
  that files that actually execute a build are `"config"`/`"other"` family or already blocked.
- **Binary/ignored files are unaffected**, and `content.block` still scans every added line
  regardless of family — a blocklisted phrase in a doc or comment is still caught.
- **Prompt injection via docs is a reviewer/LLM-judge concern, not a size one** — `docs/policy.md`'s
  existing rail is unchanged.
- **What an attacker gains: nothing beyond what the score already allows.** The size cap was never
  a security control against malicious *code* — the score, `paths.block`, `content.block` and
  `tests.deleted` are, and they still read every line. Only text that already cannot execute (prose,
  blank lines, true comments) stops counting; hiding malicious code as a "comment" still does not
  run, and `content.block` still sees it.

## 7. Tests

- `gate.test.ts`: a pure-docs PR is fully excluded; a comment-only hunk excludes only that hunk
  while a sibling real-code hunk still counts; `sizeCapExempt` zeroes a matched file;
  `paths.instructions` overrides both `sizeCapExempt` and docs-family; a test file under
  `sizeCapExempt` still counts; `countInertLines: true` reproduces today's reason exactly; the
  two-number reason's arithmetic on a mixed PR.
- `config.test.ts`: `paths.instructions` defaults present and additive; `sizeCapExempt` gets the
  same glob-validation errors as other lists; `countInertLines` defaults `false`.
- A new small per-hunk helper (reusing `inert()`): all-comment, mixed, blank-only and renamed-file
  (never inert) cases.
- If `contract.instructions` ships (§3): one fact per file, capped at 3, mirroring
  `contract.schema`'s tests.

**Evaluation against this repo's own recent PRs**, replayed against the documented default
`maxChangedLines: 400` (this repo's own config actually sets `1000`, so none of these PRs tripped
the cap for real — the table shows the mechanism, the same way the problem statement's "PR #39,
765 lines" example does):

| PR | raw lines | inert | counted | before → after |
|---|---|---|---|---|
| #33 (docs, archived patch) | 481 | 481 | 0 | fires → passes |
| #36 (docs, field-test note) | 290 | 290 | 0 | already under cap → unchanged |
| #38 (bench, 610-line `.ts` experiment) | 766 | 154 | 612 | fires → still fires (the experiment code is the size) |
| #39 (bench, touches `.opendrs.yml`) | 698 | 198 | 500 | fires → still fires, plus hard-blocked by `paths.block` |
| #35 (code, fix PR) | 937 | 76 | 861 | fires → still fires (tests alone, 575, exceed the cap) |
| #40 (code, module boundaries) | 1134 | 511 | 623 | fires → still fires (code+tests, 623, exceed the cap) |

Only the two PRs that were *actually* all docs (#33, #36) flip, and #36 was never over the cap. The
rest keep today's decision because their code or test lines alone already exceed 400.

## 8. Decisions (approved 2026-10-20)

1. **No `unblock`-style escape for `paths.instructions`.** It stays additive only, like
   `paths.block`/`paths.critical`: a config's own list extends it, nothing removes a default entry.
   A repo whose own `SKILL.md`-named file is genuinely inert still counts it in full; that is the
   deliberate asymmetry (§3) that keeps agent-instruction files from quietly re-opening a size-cap
   hole.
2. **Ship `contract.instructions` now, as a real strong captain fact**, not a placeholder
   PR-comment note: "Changes agent instructions: `CLAUDE.md`". The captain brief
   (`docs/specs/2026-10-19-captain-brief-design.md`) shipped in 0.4.0 — it is not a draft, whatever
   wording earlier drafts of this document used — so there is no reason to wait for it. Register
   the fact in `src/architecture` next to `contract.dependency`/`contract.api`/`contract.schema`/
   `contract.env` so `ArchitectureFactId`, `DETECTOR_RANK` and the sort order in
   `src/architecture/index.ts` stay consistent; a different in-flight branch is adding its own
   `risk` detector/fact id to the same files, so add this one cleanly (no renumbering of existing
   ranks) rather than reshuffling.
3. **New behaviour on by default:** `autoApprove.countInertLines: false` ships in this minor
   version, not held behind a one-release opt-in. A CHANGELOG `### Changed` entry calls out the
   default-behaviour change explicitly (§5's backward-compatibility note already states why: an
   opt-in flag nobody sets would not fix the PR #39-style blocks this spec targets).
4. **Caveat, documented, not pre-listed.** No general pre-listing of "repos with an executable
   `docs/**`" — that is per-repo knowledge only the repo owner has. Instead, the caveat in §6
   ("Docs folders with executable content") is written up explicitly in the user-facing docs
   (`docs/policy.md`, `docs/auto-approve.md`, `docs/configuration.md`): a Jekyll `_layouts/**.html`,
   a notebook's `.ipynb`, or site JS under `docs/assets/**` is `"other"` or unclassified by
   `languageFamily`, so it is never inert by default — it only stops counting if the repo owner
   explicitly lists it under `autoApprove.sizeCapExempt` from the base branch, the same trust
   boundary every other `.opendrs.yml` setting has.
5. **Yes, add a commented-out example.** `opendrs init`'s generated config (`src/cli/templates.ts`)
   gets a commented `# sizeCapExempt: ["docs/assets/**"]`-style example next to the new
   `autoApprove.sizeCapExempt`/`countInertLines` keys, so the caveat in (4) has a worked example
   right where someone would reach for it. `tests/cli/init-mcp.test.ts`'s template-parity check
   (the template must parse to exactly `defaultConfig()`) keeps passing because the example line
   stays a comment.

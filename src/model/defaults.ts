import type { ModelWeights } from "../domain/types.js";

/*
 * Hand-set prior weights, used until `opendrs calibrate` fits the repo's own history.
 *
 * Feature choice and signs follow Meta's LR baseline (arXiv 2410.06351) and the JIT defect
 * prediction literature (Kamei et al. 2013; McIntosh & Kamei 2018): size/churn, diffusion,
 * prior-fix history and author experience are the strongest predictors; experience lowers
 * risk. Magnitudes are tuned so the spec §5 fixtures land on target
 * (tests/model/defaults.test.ts):
 *   docs typo ≈ 0.05, 100-line change with tests ≈ 0.19, 600-line untested hub change ≈ 0.94,
 *   40-line change in a critical path ≈ 0.35, new-files-only feature (tests.missing ≈ 0.33) ≈ 0.09.
 * Notes:
 * - Most features are log1p counts, so a weight of 0.25 on size.churn means ~+0.17 logit per
 *   doubling of changed lines.
 * - size.new_files_only is negative: Meta found new-file-only diffs rarely cause SEVs.
 * - size.comment_only is strongly negative: Meta notes a comment-only change "has no risk" even on a
 *   risky path. -2.0 brings a comment edit to an incident-prone critical file (≈ 0.70 as code) to ≈ 0.24.
 * - paths.critical is the largest single bump (Meta's "high-criticality service").
 * - paths.blocked is also a policy hard block; its weight only colours the score.
 * - tests.deleted (a test file deleted, or net test deletion of 10+ lines) is also a policy rule. Its
 *   weight 1.0 puts an owner's deletion of a security check plus its tests at ≈ 0.37, yellow.
 * - lang.*: docs and config lower risk; code families (lang.ts, lang.py, ...) are absent, i.e. 0,
 *   until calibration fits them.
 * - llm.semantic is max(0, logit(p) - logit(0.2)) from the LLM judge: it only adds risk above a
 *   0.2 baseline and can never lower the score, so a judge talked into p ≈ 0 changes nothing.
 *   The weight 0.8 shrinks it toward the other evidence (p = 0.5 adds ~+1.1 logit, p = 0.9 ~+2.9).
 * - llm.risk.<category> is 1 when the judge put any hunk in that RADAR risk category (arXiv
 *   2605.30208 §2.8). logic_bug and security are the categories that name an incident cause, so
 *   they get 0.6 (a bit under paths.critical); performance, structural and complex say "look
 *   closer" rather than "this is wrong" and get 0.3. All positive: like llm.semantic, the judge can
 *   only add risk. Calibration floors every llm.* weight at 0 for the same reason.
 * - intercept -2.85 puts an empty diff at ≈ 0.05.
 */
export const DEFAULT_WEIGHTS: ModelWeights = {
  version: 1,
  intercept: -2.85,
  weights: {
    "size.churn": 0.25,
    "size.relative": 0.3,
    "size.new_files_only": -0.5,
    "size.comment_only": -2.0,
    "diffusion.files": 0.2,
    "diffusion.dirs": 0.1,
    "diffusion.authors": 0.15,
    "history.prior_fixes": 0.3,
    "history.incident": 0.8,
    "history.churn": 0.05,
    "expertise.author_commits": -0.3,
    "expertise.owner_ratio": -0.3,
    "complexity.touched": 0.04,
    "blast.dependents": 0.2,
    "blast.public_surface": 0.4,
    "paths.critical": 1.2,
    "paths.blocked": 0.5,
    "tests.missing": 0.7,
    "tests.deleted": 1.0,
    "lang.docs": -0.4,
    "lang.config": -0.3,
    "llm.semantic": 0.8,
    "llm.risk.logic_bug": 0.6,
    "llm.risk.security": 0.6,
    "llm.risk.performance": 0.3,
    "llm.risk.structural": 0.3,
    "llm.risk.complex": 0.3,
  },
  // Used for a signal whose status is `unknown` (or that is missing). A typical value, not the
  // best case, because unknown is never zero risk.
  priors: {
    "blast.dependents": Math.log1p(10),
    "blast.public_surface": 0.5,
    "tests.missing": 0.5,
  },
};

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
 *   40-line change in a critical path ≈ 0.35, new-files-only feature ≈ 0.08.
 * Notes:
 * - Most features are log1p counts, so a weight of 0.25 on size.churn means ~+0.17 logit per
 *   doubling of changed lines.
 * - size.new_files_only is negative: Meta found new-file-only diffs rarely cause SEVs.
 * - paths.critical is the largest single bump (Meta's "high-criticality service").
 * - paths.blocked is also a policy hard block; its weight only colours the score.
 * - lang.*: docs and config lower risk; code families are ~0 until calibration says otherwise.
 * - llm.semantic is logit(p) from the LLM judge, so a weight of 0.8 shrinks it toward the
 *   other evidence rather than letting it dominate (spec §5).
 * - intercept -2.85 puts an empty diff at ≈ 0.05.
 */
export const DEFAULT_WEIGHTS: ModelWeights = {
  version: 1,
  intercept: -2.85,
  weights: {
    "size.churn": 0.25,
    "size.relative": 0.3,
    "size.new_files_only": -0.5,
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
    "lang.docs": -0.4,
    "lang.config": -0.3,
    "lang.js": 0,
    "lang.python": 0,
    "lang.go": 0,
    "lang.jvm": 0,
    "lang.rust": 0,
    "lang.ruby": 0,
    "lang.c": 0,
    "lang.shell": 0,
    "lang.other": 0,
    "llm.semantic": 0.8,
  },
  // Only used when a provider emits nothing for the id. A typical value, not the best case,
  // because unknown is never zero risk.
  priors: {
    "blast.dependents": Math.log1p(10),
    "blast.public_surface": 0.5,
    "tests.missing": 0.5,
  },
};

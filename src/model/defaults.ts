import type { ModelWeights } from "../domain/types.js";

/** Hand-set prior weights used before `opendrs calibrate` (workstream C tunes these). */
export const DEFAULT_WEIGHTS: ModelWeights = { version: 1, intercept: -3, weights: {} };

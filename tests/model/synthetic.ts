import type { Signal } from "../../src/domain/types.js";
import { mulberry32 } from "../../src/model/fit.js";
import { sigmoid } from "../../src/model/logistic.js";
import type { ReplayRow } from "../../src/model/replay.js";

const sig = (id: string, value: number): Signal => ({ id, value, status: "observed", summary: id, evidence: [] });

/**
 * Synthetic replayed history: risk is driven by churn and missing tests, experience lowers it,
 * and `noise` carries no signal. Times increase with index (oldest first).
 */
export function syntheticRows(n: number, seed = 1): ReplayRow[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const churn = Math.log1p(Math.floor(rand() * 800));
    const testsMissing = rand() < 0.4 ? 1 : 0;
    const experience = Math.log1p(Math.floor(rand() * 300));
    const noise = rand();
    const p = sigmoid(-4 + 0.9 * churn + 1.5 * testsMissing - 0.5 * experience);
    return {
      sha: `c${i}`,
      time: 1_700_000_000 + i * 3600,
      label: rand() < p ? 1 : 0,
      signals: [
        sig("size.churn", churn),
        sig("tests.missing", testsMissing),
        sig("expertise.author_commits", experience),
        sig("noise.feature", noise),
      ],
    };
  });
}

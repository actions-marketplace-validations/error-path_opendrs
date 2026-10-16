import { basename } from "node:path";
import type { ModelWeights, Signal } from "../domain/types.js";
import { OpendrsError } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";
import { DEFAULT_WEIGHTS } from "./defaults.js";
import { fitLogistic, resampleNegatives, timeSplit } from "./fit.js";
import { featureValues, scoreSignals } from "./logistic.js";
import { evaluate, percentiles } from "./metrics.js";
import { replayHistory, type ReplayRow } from "./replay.js";

export interface HistoryRunOptions {
  repoDir: string;
  config: OpendrsConfig;
  /** Only commits newer than this (ISO date or git date string). */
  since?: string;
  maxCommits?: number;
  /** Progress callback for CLI output. */
  onProgress?: (done: number, total: number) => void;
  /** Ref to replay from; also where the import graph is built. Default "HEAD". */
  head?: string;
  /**
   * External labels. When set, exactly these commits are replayed, with these labels: SZZ-lite
   * labelling and the label horizon are skipped. `since` and `maxCommits` still bound the walk.
   */
  labels?: Map<string, 0 | 1>;
}

/** Fit weights on the repo's own labelled history (spec §5). `warnings` are the replay's (see ReplayResult). */
export async function calibrate(opts: HistoryRunOptions): Promise<{ model: ModelWeights; warnings: string[] }> {
  const { rows, warnings } = await replayHistory(opts);
  return { model: fitModel(rows, DEFAULT_WEIGHTS, basename(opts.repoDir)), warnings };
}

const RESAMPLE_RATIO = 5;
const RESAMPLE_SEED = 1;

/**
 * Fit on the oldest 80 % (negatives resampled 5:1), evaluate on the newest 20 %. Features the
 * history never varies (e.g. llm.semantic when no LLM scores were collected) keep their prior weight.
 */
export function fitModel(rows: ReplayRow[], prior: ModelWeights = DEFAULT_WEIGHTS, repo?: string): ModelWeights {
  const { train, test } = timeSplit(rows);
  const positives = train.filter((r) => r.label === 1).length;
  if (positives === 0) {
    throw new OpendrsError(
      `No positive labels among ${train.length} training commits (no reverts, fix-blamed commits or incidents). ` +
        "Add .opendrs/incidents.jsonl or widen --since/--max-commits.",
      "usage",
    );
  }

  const ids = [...new Set([...Object.keys(prior.weights), ...rows.flatMap((r) => r.signals.map((s) => s.id))])].sort();
  const fitOn = (part: ReplayRow[], l2: number) => {
    const sample = resampleNegatives(part, (r) => r.label === 1, RESAMPLE_RATIO, RESAMPLE_SEED);
    const fit = fitLogistic(
      sample.map((r) => featureVector(r.signals, ids, prior.priors)),
      sample.map((r) => r.label),
      { l2, priorWeights: ids.map((id) => prior.weights[id] ?? 0) },
    );
    return { sample, fit };
  };
  const choice = chooseL2(train, ids, prior, fitOn);
  const { sample, fit } = fitOn(train, choice.l2);

  // Prior correction (King & Zeng 2001): the fit saw the resampled positive rate; shift the
  // intercept so scores are probabilities at the repo's real base rate.
  const sampleRate = sample.filter((r) => r.label === 1).length / sample.length;
  const trueRate = positives / train.length;
  const correction = trueRate < 1 && sampleRate < 1 ? Math.log(((1 - trueRate) / trueRate) * (sampleRate / (1 - sampleRate))) : 0;
  // Keep the priors when the fit could not beat them on unseen validation commits: a noisy or
  // small history should not replace a sensible default with a worse model.
  const keepPriors = choice.priorsAuc !== undefined && choice.priorsAuc >= choice.auc;
  const model: ModelWeights = keepPriors
    ? { version: 1, intercept: prior.intercept, weights: { ...prior.weights }, ...(prior.priors ? { priors: prior.priors } : {}) }
    : {
        version: 1,
        intercept: fit.intercept - correction,
        // The LLM may only add risk (spec §8), so no llm.* weight can ever turn negative.
        weights: Object.fromEntries(ids.map((id, j) => [id, id.startsWith("llm.") ? Math.max(0, fit.weights[j]!) : fit.weights[j]!])),
        ...(prior.priors ? { priors: prior.priors } : {}),
      };
  const score = (r: ReplayRow) => scoreSignals(r.signals, model).score;
  return {
    ...model,
    percentiles: percentiles(rows.map(score)),
    trainedOn: {
      ...(repo ? { repo } : {}),
      commits: train.length,
      positives,
      from: isoTime(train[0]!.time),
      to: isoTime(train[train.length - 1]!.time),
    },
    metrics: evaluate(test.map(score), test.map((r) => r.label)),
    ...(choice.priorsAuc !== undefined
      ? { calibration: { chosen: keepPriors ? "priors" : "fitted", validationAuc: { fitted: choice.auc, priors: choice.priorsAuc } } }
      : {}),
  };
}

const L2_CANDIDATES = [10, 1, 0.1, 0.01];

/**
 * Pick the penalty by a second time-ordered split inside the training window, so the held-out
 * test commits stay unseen. Strongest penalty (closest to the priors) wins unless a weaker one
 * ranks validation commits clearly better. Also scores the priors on the same slice, so the
 * caller can keep them when no fit beats them.
 */
function chooseL2(
  train: ReplayRow[],
  ids: string[],
  prior: ModelWeights,
  fitOn: (part: ReplayRow[], l2: number) => { fit: { intercept: number; weights: number[] } },
): { l2: number; auc: number; priorsAuc?: number } {
  const { train: inner, test: validation } = timeSplit(train);
  const labels = validation.map((r) => r.label);
  if (!inner.some((r) => r.label === 1) || !labels.includes(1) || !labels.includes(0)) return { l2: L2_CANDIDATES[0]!, auc: NaN };
  let best = { l2: L2_CANDIDATES[0]!, auc: -Infinity };
  for (const l2 of L2_CANDIDATES) {
    const { fit } = fitOn(inner, l2);
    const model: ModelWeights = { version: 1, intercept: fit.intercept, weights: Object.fromEntries(ids.map((id, j) => [id, fit.weights[j]!])), priors: prior.priors };
    const { auc } = evaluate(validation.map((r) => scoreSignals(r.signals, model).score), labels);
    if (auc > best.auc + 0.005) best = { l2, auc };
  }
  const priorsAuc = evaluate(validation.map((r) => scoreSignals(r.signals, prior).score), labels).auc;
  return { ...best, priorsAuc };
}

/** Same value rule as scoreSignals, so fitting and scoring see identical x. */
function featureVector(signals: Signal[], ids: string[], priors: Record<string, number> | undefined): number[] {
  const values = featureValues(signals, priors);
  return ids.map((id) => values.get(id) ?? priors?.[id] ?? 0);
}

const isoTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

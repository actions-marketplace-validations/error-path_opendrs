/**
 * bench/verify: label matching and cost-cap arithmetic, extracted from run.ts so they can be
 * unit-tested with no API calls and no `dist/` build (run.ts itself imports `dist/`, which does
 * not exist until the verification-pass core branches are built and merged — see README.md).
 */

export type FactLabel = "true-useful" | "noise" | "wrong" | "unclassified";

/** One captain fact a field-test session note judged, as recorded in labels.json. */
export interface LabelledFact {
  id: string;
  file: string | null;
  line?: number;
  partner?: string;
  label: FactLabel;
  note?: string;
  ambiguous?: boolean;
}

export interface LabelledPr {
  pr: number | null;
  slug: string;
  base: string;
  head: string;
  isCommitRangeStandin?: boolean;
  note?: string;
  facts: LabelledFact[];
}

export interface LabelledRepo {
  repo: string;
  slug: string;
  language?: string;
  head: string;
  cloneMode?: string;
  config?: unknown;
  note?: string;
  prs: LabelledPr[];
}

export interface LabelsFile {
  meta: Record<string, unknown>;
  repos: LabelledRepo[];
}

/** A labelled fact flattened with the repo/PR it belongs to. */
export interface FlatLabelledFact extends LabelledFact {
  repoSlug: string;
  prSlug: string;
  prBase: string;
  prHead: string;
}

/**
 * `factId` exactly as `src/brief/selfcheck.ts` computes it for a live `ArchitectureFact`:
 * `${fact.id}:${fact.file}${fact.line === undefined ? "" : ":" + fact.line}`. A labelled fact
 * with `file: null` (the one unaccounted black 1ed66a8 fact) has no real factId; it is given a
 * placeholder so it never collides with a real one.
 */
export function factId(fact: { id: string; file: string | null; line?: number }): string {
  if (fact.file === null) return `${fact.id}:(unclassified)`;
  return `${fact.id}:${fact.file}${fact.line === undefined ? "" : `:${fact.line}`}`;
}

/** Every labelled fact in the file, flattened with its repo/PR context, in file order. */
export function flattenLabels(labels: LabelsFile): FlatLabelledFact[] {
  const out: FlatLabelledFact[] = [];
  for (const repo of labels.repos) {
    for (const pr of repo.prs) {
      for (const fact of pr.facts) {
        out.push({ ...fact, repoSlug: repo.slug, prSlug: pr.slug, prBase: pr.base, prHead: pr.head });
      }
    }
  }
  return out;
}

/**
 * Groups flattened facts by their (collapsed) factId. `ArchitectureFact` (src/domain/types.ts)
 * carries no partner/index field, so several labelled instances sharing one id+file+line (e.g.
 * vite 77d837351's 10 coupling.missing fires on the same file) collapse to one factId — the same
 * collision the live brief would produce. Callers must decide how to score a collapsed group
 * (see README.md's "Known limitation").
 */
export function groupByFactId(facts: FlatLabelledFact[]): Map<string, FlatLabelledFact[]> {
  const groups = new Map<string, FlatLabelledFact[]>();
  for (const fact of facts) {
    const id = factId(fact);
    const group = groups.get(id);
    if (group) group.push(fact);
    else groups.set(id, [fact]);
  }
  return groups;
}

/** Counts of each label across a flattened fact list, for sanity-checking against the field
 * test's own summary table (docs/research/2026-10-19-field-test.md). */
export function tallyLabels(facts: FlatLabelledFact[]): Record<FactLabel, number> {
  const tally: Record<FactLabel, number> = { "true-useful": 0, noise: 0, wrong: 0, unclassified: 0 };
  for (const fact of facts) tally[fact.label]++;
  return tally;
}

// ---------------------------------------------------------------------------------------------
// Cost-cap arithmetic
// ---------------------------------------------------------------------------------------------

export interface Prices {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** $ per million input/output tokens. Sonnet 5 confirmed via the `claude-api` skill (list price,
 * cached 2026-06-24); never priced from memory. Kept in sync with bench/apachejit/llm.ts's own
 * PRICES table intentionally — if that table changes, update this one the same way. */
export const PRICES: Record<string, Prices> = {
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-fable-5-1": { inputPerMillion: 10, outputPerMillion: 50 },
};

/** Rough upper bound: ~3.5 characters per input token (same estimate bench/apachejit/llm.ts uses). */
export const CHARS_PER_TOKEN = 3.5;
/** Output-token allowance reserved per call before the real `usage` is known. */
export const OUTPUT_TOKEN_ALLOWANCE = 2_000;

/** Estimated dollar cost of one verify call, from its prompt size alone (chars ÷ 3.5 × input
 * price, plus a fixed output-token allowance × output price). Call this BEFORE every call. */
export function estimateCallCostUsd(promptChars: number, prices: Prices, outputTokens = OUTPUT_TOKEN_ALLOWANCE): number {
  const inputTokens = promptChars / CHARS_PER_TOKEN;
  return (inputTokens * prices.inputPerMillion + outputTokens * prices.outputPerMillion) / 1e6;
}

/** Actual dollar cost of a call from its real `usage`, once known. */
export function actualCallCostUsd(usage: { inputTokens: number; outputTokens: number }, prices: Prices): number {
  return (usage.inputTokens * prices.inputPerMillion + usage.outputTokens * prices.outputPerMillion) / 1e6;
}

/** Remaining spend allowed under `--max-usd`, and the prices to estimate against. */
export interface Budget {
  left: number;
  prices: Prices;
}

export type ReserveResult = { ok: true; estimatedCost: number } | { ok: false; estimatedCost: number };

/**
 * Whether starting one more call would stay under the cap, given its estimated cost. On `ok:
 * true` the estimate is reserved (subtracted from `budget.left`) as a side effect, so the next
 * call's estimate is checked against what is actually left — this is what lets run.ts "abort the
 * whole run before any call that could cross the cap" (the task's hard-cap requirement), not just
 * the one call that would. On `ok: false`, `budget.left` is left untouched.
 */
export function reserveIfAffordable(budget: Budget, promptChars: number, outputTokens = OUTPUT_TOKEN_ALLOWANCE): ReserveResult {
  const estimatedCost = estimateCallCostUsd(promptChars, budget.prices, outputTokens);
  if (estimatedCost > budget.left) return { ok: false, estimatedCost };
  budget.left -= estimatedCost;
  return { ok: true, estimatedCost };
}

/** Reconciles a reserved estimate against the call's real `usage` once it returns: refunds the
 * estimate and charges the actual cost, so `budget.left` tracks real spend, not the estimate. */
export function reconcileActualSpend(budget: Budget, reservedCost: number, usage: { inputTokens: number; outputTokens: number }): number {
  const actual = actualCallCostUsd(usage, budget.prices);
  budget.left += reservedCost - actual;
  return actual;
}

// ---------------------------------------------------------------------------------------------
// Fail-fast: the study must never mistake a provider outage for a measurement (see README.md's
// "Prerequisites" and the ledger entry for the run that returned HTTP 400 on all 48 PRs for $0).
// ---------------------------------------------------------------------------------------------

export type ErrorClass = "fatal" | "transient";

/**
 * Classifies a provider error message (as thrown by src/llm/http.ts's `postJson`, e.g.
 * `"Anthropic API request failed: HTTP 400: This API key is not scoped to a workspace..."`).
 * 429 (rate limit), 5xx and timeouts/network failures are transient — worth a retry with
 * backoff. Any other 4xx (400/401/403/404/...) is an account-level problem (bad key, wrong scope,
 * no permission) that will not resolve itself on retry: fatal, abort before spending anything
 * else on it.
 */
export function classifyProviderError(message: string): ErrorClass {
  if (/HTTP 429/.test(message) || /HTTP 5\d\d/.test(message)) return "transient";
  if (/HTTP 4\d\d/.test(message)) return "fatal";
  return "transient"; // timeout or network-level failure ("request timed out", "request failed: fetch failed")
}

/** Exponential backoff for retrying a transient provider error: 1s, 2s, 4s, ..., capped at 10s. */
export function backoffDelayMs(attempt: number, baseMs = 1_000, maxMs = 10_000): number {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}

export interface ValidityResult {
  invalid: boolean;
  failedCount: number;
  scoredCount: number;
  failedShare: number;
}

/**
 * A run where the verifier's own fail-open contract ("any error fails open: nothing is dropped or
 * downgraded, every candidate renders [unverified]", src/brief/verify.ts) triggered for most
 * scored PRs reflects an outage, not a measurement — every unverified candidate keeps its action,
 * so precision reads as near-zero regardless of the verifier's real behaviour. This is exactly
 * what happened in the previous run (48 of 48 PRs, HTTP 400, $0 spent): the preflight check
 * (run.ts) should catch that case before it ever reaches here, but this is the independent
 * safety net — if most scored PRs show `verification.outcome === "failed"`, the run is INVALID
 * and no decision rule is applied, no matter what evaluateDecisionRule would have said.
 */
export function checkStudyValidity(failedCount: number, scoredCount: number): ValidityResult {
  const failedShare = scoredCount === 0 ? 1 : failedCount / scoredCount;
  return { invalid: scoredCount === 0 || failedShare > 0.5, failedCount, scoredCount, failedShare };
}

// ---------------------------------------------------------------------------------------------
// Decision rule (spec §3.7, with the §3.8 amendment)
// ---------------------------------------------------------------------------------------------

export interface DecisionInputs {
  /** True+useful facts whose final action (detector + verifier combined) was "drop". Spec §3.7.1:
   * at most 1 may be wrongly dropped. */
  trueUsefulWronglyDropped: number;
  trueUsefulTotal: number;
  /** Of the 18 coupling.missing noise fires, how many ended up drop/downgrade — by a deterministic
   * detector class (spec §3.8) OR by the verifier. The §3.8 amendment: both count toward the
   * 13-of-18 target; report the verifier-only subset separately, never conflated into this number. */
  couplingNoiseHandled: number;
  couplingNoiseTotal: number;
  /** Of the 2 contract.dependency WRONG fires, how many ended up drop/downgrade. Spec §3.7.2
   * requires both. */
  wrongFiresHandled: number;
  wrongFiresTotal: number;
  /** Measured $ spend divided by PR count. Spec §3.7.3: must be <= $0.02/PR. */
  costPerPrUsd: number;
}

export interface DecisionResult {
  recallPass: boolean;
  /** False when a recall failure stopped the study before precision was checked (spec §3.7:
   * "precision is not checked until recall clears"). */
  precisionChecked: boolean;
  precisionPass: boolean;
  costPass: boolean;
  overall: "ship" | "recall-fail" | "precision-fail" | "cost-fail";
}

const COUPLING_PRECISION_TARGET = 13 / 18;
const COST_CAP_PER_PR_USD = 0.02;

/** Evaluates spec §3.7's shipping rule exactly as written: recall first (stops the study on any
 * failure, before precision is even computed), then precision, then cost. */
export function evaluateDecisionRule(inputs: DecisionInputs): DecisionResult {
  const recallPass = inputs.trueUsefulWronglyDropped <= 1;
  const costPass = inputs.costPerPrUsd <= COST_CAP_PER_PR_USD;
  if (!recallPass) return { recallPass, precisionChecked: false, precisionPass: false, costPass, overall: "recall-fail" };

  const couplingPass = inputs.couplingNoiseTotal === 0 || inputs.couplingNoiseHandled / inputs.couplingNoiseTotal >= COUPLING_PRECISION_TARGET;
  const wrongPass = inputs.wrongFiresHandled >= inputs.wrongFiresTotal;
  const precisionPass = couplingPass && wrongPass;

  const overall = !precisionPass ? "precision-fail" : !costPass ? "cost-fail" : "ship";
  return { recallPass, precisionChecked: true, precisionPass, costPass, overall };
}

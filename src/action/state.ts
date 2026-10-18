import type { Decision, Tier } from "../domain/types.js";

/** opendrs's own re-score state, kept in its comment so a re-run can tell what changed. */
export interface OpendrsState {
  head: string;
  score: number;
  tier: Tier;
  decision: Decision;
  run: number;
}

/** Any substring shaped like a state marker, used only to check there is exactly one before parsing it strictly. */
const STATE_ANY_RE = /<!-- opendrs-state:[^>]*-->/g;
/** The one allowed shape, anchored so nothing before, after or extra inside it can smuggle another value in. */
const STATE_STRICT_RE =
  /^<!-- opendrs-state: v1 head=([0-9a-f]{40}) score=(0(?:\.\d{1,4})?|1(?:\.0{1,4})?) tier=(green|yellow|red) decision=(auto-approve|deferred-review|waiting-ai-review|human-review) run=([1-9]\d{0,5}|1000000) -->$/;

/** The hidden machine marker this Action writes into its own comment, recording this run's result. */
export const stateMarker = (s: OpendrsState): string =>
  `<!-- opendrs-state: v1 head=${s.head} score=${s.score.toFixed(4)} tier=${s.tier} decision=${s.decision} run=${s.run} -->`;

/**
 * The previous run's state, read strictly from opendrs's own comment body (callers must pass only that
 * comment, never another comment or the PR body). Anything but exactly one marker in the fixed shape
 * counts as no marker at all, so this run is treated as the first one.
 */
export function readState(body: string | undefined): OpendrsState | undefined {
  const candidates = body?.match(STATE_ANY_RE) ?? [];
  if (candidates.length !== 1) return undefined;
  const m = STATE_STRICT_RE.exec(candidates[0]!);
  if (!m) return undefined;
  return { head: m[1]!, score: Number(m[2]), tier: m[3] as Tier, decision: m[4] as Decision, run: Number(m[5]) };
}

/** "Re-scored for `<head7>` (run N) · was <prev> → now <current>": one line for the PR comment. */
export const rescoreLine = (prev: OpendrsState, run: number, head: string, score: number, tier: Tier): string =>
  `Re-scored for \`${head.slice(0, 7)}\` (run ${run}) · was ${prev.score.toFixed(2)} ${prev.tier} → now ${score.toFixed(2)} ${tier}`;

/** "opendrs: risk changed ... · decision ... · see the updated report ↑": a short, separate comment. */
export const changeNotice = (prev: OpendrsState, score: number, tier: Tier, decision: Decision): string =>
  `opendrs: risk changed ${prev.tier} ${prev.score.toFixed(2)} → ${tier} ${score.toFixed(2)} · ` +
  `decision ${prev.decision} → ${decision} · see the updated report ↑`;

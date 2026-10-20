import type { Decision, Tier } from "../domain/types.js";

/** opendrs's own re-score state, kept in its comment so a re-run can tell what changed. */
export interface OpendrsState {
  head: string;
  /** The head of opendrs's first run on this PR (spec §6.4, §7.3). Absent only when read from a 0.3.x marker. */
  first?: string;
  /** That first run's number (spec §6.4, §7.3). Absent when read from a marker written before this field existed. */
  firstRun?: number;
  score: number;
  tier: Tier;
  decision: Decision;
  run: number;
}

/** Any substring shaped like a state marker, used only to check there is exactly one before parsing it strictly. */
const STATE_ANY_RE = /<!-- opendrs-state:[^>]*-->/g;
/**
 * The one allowed shape, anchored so nothing before, after or extra inside it can smuggle another value in.
 * `first=` is optional so a marker written by 0.3.x (no `first=`) still parses; `firstRun=` is optional
 * (and only valid alongside `first=`) so a marker written before it existed still parses too. Either one
 * present but malformed fails the whole match rather than being dropped silently.
 */
const STATE_STRICT_RE =
  /^<!-- opendrs-state: v1 head=([0-9a-f]{40})(?: first=([0-9a-f]{40})(?: firstRun=([1-9]\d{0,5}|1000000))?)? score=(0(?:\.\d{1,4})?|1(?:\.0{1,4})?) tier=(green|yellow|red) decision=(auto-approve|deferred-review|waiting-ai-review|human-review) run=([1-9]\d{0,5}|1000000) -->$/;

/** The hidden machine marker this Action writes into its own comment, recording this run's result. Always carries `first=` and `firstRun=` from now on. */
export const stateMarker = (s: OpendrsState): string =>
  `<!-- opendrs-state: v1 head=${s.head} first=${s.first ?? s.head}${s.firstRun === undefined ? "" : ` firstRun=${s.firstRun}`} score=${s.score.toFixed(4)} tier=${s.tier} decision=${s.decision} run=${s.run} -->`;

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
  return {
    head: m[1]!,
    first: m[2],
    firstRun: m[3] === undefined ? undefined : Number(m[3]),
    score: Number(m[4]),
    tier: m[5] as Tier,
    decision: m[6] as Decision,
    run: Number(m[7]),
  };
}

/** "Re-scored for `<head7>` (run N) · was <prev> → now <current>": one line for the PR comment. */
export const rescoreLine = (prev: OpendrsState, run: number, head: string, score: number, tier: Tier): string =>
  `Re-scored for \`${head.slice(0, 7)}\` (run ${run}) · was ${prev.score.toFixed(2)} ${prev.tier} → now ${score.toFixed(2)} ${tier}`;

/** "opendrs: risk changed ... · decision ... · see the updated report ↑": a short, separate comment. */
export const changeNotice = (prev: OpendrsState, score: number, tier: Tier, decision: Decision): string =>
  `opendrs: risk changed ${prev.tier} ${prev.score.toFixed(2)} → ${tier} ${score.toFixed(2)} · ` +
  `decision ${prev.decision} → ${decision} · see the updated report ↑`;

export interface SlowKind {
  kind: string;
  count: number;
  p50Ms: number;
  maxMs: number;
}

export function computeSlowKinds(runs: { kind?: string; durationMs?: number }[], thresholdMs: number): SlowKind[];

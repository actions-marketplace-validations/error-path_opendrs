import type { ArchitectureFact, ArchitectureFactId, ScoringContext } from "../domain/types.js";
import { detectContracts } from "./contracts.js";
import { detectCoupling } from "./coupling.js";
import { detectDrift } from "./drift.js";
import { detectLayers } from "./layers.js";
import { detectRisk } from "./risk.js";

export interface DetectorOptions {
  /** The head of opendrs's first run on this PR, for the drift detector (spec §6.4; Action only). */
  firstHead?: string;
  /** That first run's number, for an old marker's "since run k" phrasing. */
  firstRun?: number;
}

export interface DetectorResult {
  facts: ArchitectureFact[];
  notes: string[];
}

/** A pure function of the scoring context that reports facts or a note explaining why it could not run. */
export type Detector = (ctx: ScoringContext, opts: DetectorOptions) => Promise<DetectorResult>;

/** Spec §6.5: within a weight, the fixed detector order. */
const DETECTORS: ReadonlyArray<{ name: string; detect: Detector }> = [
  { name: "layers", detect: detectLayers },
  { name: "contracts", detect: detectContracts },
  { name: "risk", detect: detectRisk },
  { name: "coupling", detect: detectCoupling },
  { name: "drift", detect: detectDrift },
];

const WEIGHT_RANK: Record<ArchitectureFact["weight"], number> = { strong: 0, info: 1 };
const DETECTOR_RANK: Record<ArchitectureFactId, number> = {
  "layers.edge": 0,
  "layers.cycle": 0,
  "contract.dependency": 1,
  "contract.api": 1,
  "contract.schema": 1,
  "contract.env": 1,
  "change.concurrency": 2,
  "change.safety_removed": 2,
  "coupling.missing": 3,
  "drift.scope": 4,
};

/** Spec §6.5: strong first; within a weight, layers < contracts < risk < coupling < drift; then file, then line. */
export function sortFacts(facts: ArchitectureFact[]): ArchitectureFact[] {
  return [...facts].sort(
    (a, b) =>
      WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight] ||
      DETECTOR_RANK[a.id] - DETECTOR_RANK[b.id] ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/** Runs layers, contracts, risk, coupling, drift (that order), catching each so one failure never stops the others. */
export async function detectArchitecture(ctx: ScoringContext, opts: DetectorOptions): Promise<DetectorResult> {
  const facts: ArchitectureFact[] = [];
  const notes: string[] = [];
  for (const { name, detect } of DETECTORS) {
    try {
      const result = await detect(ctx, opts);
      facts.push(...result.facts);
      notes.push(...result.notes);
    } catch (e) {
      notes.push(`${name}: could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { facts: sortFacts(facts), notes };
}

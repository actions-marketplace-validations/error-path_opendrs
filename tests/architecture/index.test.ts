import { describe, expect, it, vi } from "vitest";
import { detectArchitecture, sortFacts, type Detector } from "../../src/architecture/index.js";
import type { ArchitectureFact, ScoringContext } from "../../src/domain/types.js";

vi.mock("../../src/architecture/layers.js", () => ({ detectLayers: vi.fn() }));
vi.mock("../../src/architecture/contracts.js", () => ({ detectContracts: vi.fn() }));
vi.mock("../../src/architecture/risk.js", () => ({ detectRisk: vi.fn() }));
vi.mock("../../src/architecture/coupling.js", () => ({ detectCoupling: vi.fn() }));
vi.mock("../../src/architecture/drift.js", () => ({ detectDrift: vi.fn() }));

const { detectLayers } = await import("../../src/architecture/layers.js");
const { detectContracts } = await import("../../src/architecture/contracts.js");
const { detectRisk } = await import("../../src/architecture/risk.js");
const { detectCoupling } = await import("../../src/architecture/coupling.js");
const { detectDrift } = await import("../../src/architecture/drift.js");

const fact = (over: Partial<ArchitectureFact> = {}): ArchitectureFact => ({ id: "layers.edge", weight: "strong", file: "a.ts", text: "x", ...over });

describe("detectArchitecture", () => {
  it("catches a detector that throws, records a note, and still returns the others' facts", async () => {
    vi.mocked(detectLayers).mockImplementation((async () => {
      throw new Error("boom");
    }) as Detector);
    vi.mocked(detectContracts).mockResolvedValue({ facts: [fact({ id: "contract.env", file: "b.ts" })], notes: [] });
    vi.mocked(detectRisk).mockResolvedValue({ facts: [], notes: [] });
    vi.mocked(detectCoupling).mockResolvedValue({ facts: [], notes: [] });
    vi.mocked(detectDrift).mockResolvedValue({ facts: [], notes: [] });

    const result = await detectArchitecture({} as ScoringContext, {});
    expect(result.notes).toContain("layers: could not run: boom");
    expect(result.facts).toEqual([fact({ id: "contract.env", file: "b.ts" })]);
  });
});

describe("sortFacts", () => {
  it("orders strong before info", () => {
    const info = fact({ weight: "info", id: "drift.scope" });
    const strong = fact({ weight: "strong", id: "drift.scope" });
    expect(sortFacts([info, strong])).toEqual([strong, info]);
  });

  it("orders layers before contracts before risk before coupling before drift, within a weight", () => {
    const drift = fact({ id: "drift.scope" });
    const coupling = fact({ id: "coupling.missing" });
    const risk = fact({ id: "change.concurrency" });
    const contract = fact({ id: "contract.api" });
    const layer = fact({ id: "layers.cycle" });
    expect(sortFacts([drift, coupling, risk, contract, layer])).toEqual([layer, contract, risk, coupling, drift]);
  });

  it("then orders by file, then by line", () => {
    const b2 = fact({ file: "b.ts", line: 2 });
    const b1 = fact({ file: "b.ts", line: 1 });
    const a = fact({ file: "a.ts", line: 5 });
    expect(sortFacts([b2, b1, a])).toEqual([a, b1, b2]);
  });
});

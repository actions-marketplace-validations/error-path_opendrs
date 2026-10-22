import { describe, expect, it } from "vitest";
import {
  actualCallCostUsd,
  backoffDelayMs,
  checkStudyValidity,
  classifyProviderError,
  estimateCallCostUsd,
  evaluateDecisionRule,
  factId,
  flattenLabels,
  groupByFactId,
  isResumableOutcome,
  liveFactIds,
  PRICES,
  reconcileActualSpend,
  reserveIfAffordable,
  runPool,
  sumResumedSpend,
  tallyLabels,
  type Budget,
  type LabelsFile,
} from "../../bench/verify/lib.js";

const SONNET_5 = PRICES["claude-sonnet-5"]!;

describe("factId", () => {
  it("matches src/brief/selfcheck.ts's factId shape: id:file[:line]", () => {
    expect(factId({ id: "coupling.missing", file: "src/session.ts" })).toBe("coupling.missing:src/session.ts");
    expect(factId({ id: "contract.api", file: "src/api.ts", line: 42 })).toBe("contract.api:src/api.ts:42");
  });
  it("gives the unaccounted (file: null) fact a placeholder that cannot collide with a real id", () => {
    expect(factId({ id: "unclassified", file: null })).toBe("unclassified:(unclassified)");
  });
});

const LABELS: LabelsFile = {
  meta: {},
  repos: [
    {
      repo: "psf/black",
      slug: "black",
      head: "deadbeef",
      prs: [
        {
          pr: 1,
          slug: "pr-1",
          base: "a~1",
          head: "a",
          facts: [
            { id: "contract.api", file: "src/black/concurrency.py", line: 30, label: "true-useful" },
            { id: "contract.dependency", file: "pyproject.toml", label: "wrong" },
            { id: "contract.dependency", file: "pyproject.toml", label: "wrong" },
          ],
        },
        {
          pr: 2,
          slug: "pr-2",
          base: "b~1",
          head: "b",
          facts: [
            { id: "coupling.missing", file: "template/package.json", partner: "a", label: "noise" },
            { id: "coupling.missing", file: "template/package.json", partner: "b", label: "noise" },
          ],
        },
      ],
    },
  ],
};

describe("flattenLabels / tallyLabels", () => {
  it("flattens every fact with its repo/PR context, preserving order", () => {
    const flat = flattenLabels(LABELS);
    expect(flat).toHaveLength(5);
    expect(flat[0]).toMatchObject({ id: "contract.api", repoSlug: "black", prSlug: "pr-1", prBase: "a~1", prHead: "a" });
    expect(flat[3]).toMatchObject({ id: "coupling.missing", prSlug: "pr-2" });
  });

  it("tallies labels by type, matching the field-test totals this fixture encodes", () => {
    const tally = tallyLabels(flattenLabels(LABELS));
    expect(tally).toEqual({ "true-useful": 1, noise: 2, wrong: 2, unclassified: 0 });
  });
});

describe("liveFactIds", () => {
  it("collects the brief's captain facts under the same factId every labelled fact uses", () => {
    const brief = { captain: { facts: [{ id: "contract.api", file: "src/black/concurrency.py", line: 30 }, { id: "contract.dependency", file: "pyproject.toml", line: 71 }] } };
    expect(liveFactIds(brief)).toEqual(new Set(["contract.api:src/black/concurrency.py:30", "contract.dependency:pyproject.toml:71"]));
  });

  it("is empty for a brief with no captain facts, or no brief at all (e.g. a budget-skipped PR)", () => {
    expect(liveFactIds({ captain: { facts: [] } })).toEqual(new Set());
    expect(liveFactIds({})).toEqual(new Set());
    expect(liveFactIds(undefined)).toEqual(new Set());
  });

  it("never contains a labelled WRONG fact that the detector fix eliminated (no line: the labels file's two pyproject.toml WRONG facts)", () => {
    // bench/verify/labels.json's black/winloop-dep PR: only the real `winloop` dependency fires
    // live (0.4.1's PEP 508 marker fix, commit e66ca46); the two WRONG facts never appear.
    const baseline = { captain: { facts: [{ id: "contract.dependency", file: "pyproject.toml", line: 71 }] } };
    expect(liveFactIds(baseline).has(factId({ id: "contract.dependency", file: "pyproject.toml" }))).toBe(false);
  });
});

describe("groupByFactId", () => {
  it("collapses several labelled instances that share one id+file+line into one group", () => {
    const groups = groupByFactId(flattenLabels(LABELS));
    // The two coupling.missing facts on template/package.json have no line, so they share one factId.
    const collapsed = groups.get("coupling.missing:template/package.json");
    expect(collapsed).toHaveLength(2);
    expect(collapsed?.map((f) => f.partner)).toEqual(["a", "b"]);
  });

  it("keeps distinct ids/files in separate groups", () => {
    const groups = groupByFactId(flattenLabels(LABELS));
    expect(groups.size).toBe(3); // contract.api:...:30, contract.dependency:pyproject.toml (x2 collapsed), coupling.missing:... (x2 collapsed)
    expect(groups.get("contract.dependency:pyproject.toml")).toHaveLength(2);
  });
});

describe("cost-cap arithmetic", () => {
  it("estimateCallCostUsd matches hand arithmetic for Sonnet 5", () => {
    // 35,000 chars / 3.5 = 10,000 input tokens; 2,000 output tokens (default allowance).
    const cost = estimateCallCostUsd(35_000, SONNET_5);
    const expected = (10_000 * 2 + 2_000 * 10) / 1e6;
    expect(cost).toBeCloseTo(expected, 10);
    expect(cost).toBeCloseTo(0.04, 10);
  });

  it("actualCallCostUsd prices real usage the same way", () => {
    expect(actualCallCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, SONNET_5)).toBeCloseTo(2, 10);
    expect(actualCallCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }, SONNET_5)).toBeCloseTo(10, 10);
  });

  it("reserveIfAffordable reserves the estimate and refuses once it would cross the cap", () => {
    const budget: Budget = { left: 0.05, prices: SONNET_5 };
    const first = reserveIfAffordable(budget, 35_000); // ~$0.04
    expect(first.ok).toBe(true);
    expect(budget.left).toBeCloseTo(0.01, 10);

    const second = reserveIfAffordable(budget, 35_000); // would need another ~$0.04, only $0.01 left
    expect(second.ok).toBe(false);
    // Refused reservation must not touch the budget.
    expect(budget.left).toBeCloseTo(0.01, 10);
  });

  it("aborts the run before a call that could cross the cap, not only the call that would", () => {
    // Three calls at ~$0.02 each against a $0.05 cap: the third must be refused even though it
    // alone (~$0.02) is smaller than what's nominally "left" after naive per-call checking would
    // suggest, because the first two already reserved their share.
    const budget: Budget = { left: 0.05, prices: SONNET_5 };
    const chars = 17_500; // ~5,000 input tokens: (5000*2 + 2000*10)/1e6 = 0.03
    const r1 = reserveIfAffordable(budget, chars);
    const r2 = reserveIfAffordable(budget, chars);
    const r3 = reserveIfAffordable(budget, chars);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false); // 0.03 + 0.03 > 0.05
    expect(r3.ok).toBe(false);
    expect(budget.left).toBeCloseTo(0.02, 10);
  });

  it("reconcileActualSpend refunds the estimate and charges the real usage", () => {
    const budget: Budget = { left: 1, prices: SONNET_5 };
    const { estimatedCost } = reserveIfAffordable(budget, 35_000) as { ok: true; estimatedCost: number };
    const leftAfterReserve = budget.left;
    const actual = reconcileActualSpend(budget, estimatedCost, { inputTokens: 5_000, outputTokens: 500 });
    expect(actual).toBeCloseTo((5_000 * 2 + 500 * 10) / 1e6, 10);
    // Real usage (~$0.015) was cheaper than the estimate (~$0.04), so more is left than right after reserving.
    expect(budget.left).toBeGreaterThan(leftAfterReserve);
  });
});

describe("runPool (bounded concurrency for --concurrency)", () => {
  it("runs every item exactly once", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never runs more than `limit` workers at once", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    await runPool(items, 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // actually ran concurrently, not serially
  });

  it("stops claiming new items once shouldStop() flips, but lets in-flight ones finish", async () => {
    const started: number[] = [];
    let stop = false;
    const items = [1, 2, 3, 4, 5, 6];
    await runPool(
      items,
      2,
      async (n) => {
        started.push(n);
        if (n === 2) stop = true; // flips mid-run, before every item has even started
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      () => stop,
    );
    // Both initial workers (items 1 and 2) are already in flight when `stop` flips and must
    // finish; nothing claimed after the flag flips, so well under all 6 items start.
    expect(started.length).toBeLessThan(items.length);
    expect(started).toContain(1);
    expect(started).toContain(2);
  });

  it("the budget reservation stays atomic under concurrency: never overdraws, every affordable item charged exactly once", async () => {
    // Mirrors scorePr's real shape: an await (baseline work) BEFORE the synchronous reserve, then
    // another await (the real call) after. If the reserve were anything but a synchronous,
    // non-interleaved step, two concurrent workers could both pass the affordability check
    // against the same stale `budget.left` and together overdraw it.
    const budget: Budget = { left: 0.05, prices: SONNET_5 };
    const chars = 17_500; // ~$0.03/call (per the arithmetic test above): only 1 fits in a $0.05 budget
    const results: Array<{ ok: boolean }> = [];
    await runPool(
      Array.from({ length: 10 }, (_, i) => i),
      5,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5)); // simulate the baseline-build await
        const reserved = reserveIfAffordable(budget, chars); // the atomic step: synchronous, no await around it
        results.push({ ok: reserved.ok });
        if (reserved.ok) await new Promise((resolve) => setTimeout(resolve, Math.random() * 5)); // simulate the real call
      },
    );
    expect(budget.left).toBeGreaterThanOrEqual(0); // never overdrawn
    expect(results.filter((r) => r.ok)).toHaveLength(1); // chars ~= $0.03/call against a $0.05 cap: only 1 fits
  });
});

describe("isResumableOutcome / sumResumedSpend (--resume)", () => {
  it("a verified outcome (has a verification field) is resumable", () => {
    expect(isResumableOutcome({ verification: { outcome: "verified", usage: { inputTokens: 1, outputTokens: 1 } } })).toBe(true);
  });

  it("a baseline-only record (no verification field — the PR was never actually scored) is not resumable", () => {
    expect(isResumableOutcome({ captain: { facts: [] } })).toBe(false);
    expect(isResumableOutcome(null)).toBe(false);
    expect(isResumableOutcome("not an object")).toBe(false);
  });

  it("sums real $ already spent across resumed outcomes, treating a usage-less (skipped) verifier as $0", () => {
    const outcomes = [{ verification: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } }, { verification: { usage: { inputTokens: 0, outputTokens: 1_000_000 } } }, { verification: { outcome: "skipped" as const } }];
    expect(sumResumedSpend(outcomes, SONNET_5)).toBeCloseTo(12, 10); // $2 + $10 + $0
  });
});

describe("evaluateDecisionRule (spec §3.7)", () => {
  const base = {
    trueUsefulWronglyDropped: 0,
    trueUsefulTotal: 14,
    couplingNoiseHandled: 13,
    couplingNoiseTotal: 18,
    wrongFiresHandled: 2,
    wrongFiresTotal: 2,
    costPerPrUsd: 0.01,
  };

  it("ships when recall, precision and cost all clear", () => {
    const result = evaluateDecisionRule(base);
    expect(result).toEqual({ recallPass: true, precisionChecked: true, precisionPass: true, costPass: true, overall: "ship" });
  });

  it("stops at recall and never checks precision when more than 1 true-useful fact is wrongly dropped", () => {
    const result = evaluateDecisionRule({ ...base, trueUsefulWronglyDropped: 2 });
    expect(result.recallPass).toBe(false);
    expect(result.precisionChecked).toBe(false);
    expect(result.overall).toBe("recall-fail");
  });

  it("recall tolerates exactly 1 wrongly-dropped true-useful fact", () => {
    const result = evaluateDecisionRule({ ...base, trueUsefulWronglyDropped: 1 });
    expect(result.recallPass).toBe(true);
    expect(result.precisionChecked).toBe(true);
  });

  it("fails precision when coupling.missing handling falls short of 13 of 18", () => {
    const result = evaluateDecisionRule({ ...base, couplingNoiseHandled: 12 });
    expect(result.precisionPass).toBe(false);
    expect(result.overall).toBe("precision-fail");
  });

  it("fails precision when either contract.dependency WRONG fire is not handled", () => {
    const result = evaluateDecisionRule({ ...base, wrongFiresHandled: 1 });
    expect(result.precisionPass).toBe(false);
    expect(result.overall).toBe("precision-fail");
  });

  it("fails cost when $/PR exceeds the 0.02 cap, even with recall and precision clear", () => {
    const result = evaluateDecisionRule({ ...base, costPerPrUsd: 0.021 });
    expect(result.recallPass).toBe(true);
    expect(result.precisionPass).toBe(true);
    expect(result.costPass).toBe(false);
    expect(result.overall).toBe("cost-fail");
  });

  it("precision is checked at exactly the 13/18 boundary", () => {
    expect(evaluateDecisionRule({ ...base, couplingNoiseHandled: 13, couplingNoiseTotal: 18 }).precisionPass).toBe(true);
  });
});

describe("classifyProviderError", () => {
  it("classifies the real failure from the previous run (HTTP 400, not scoped to a workspace) as fatal", () => {
    expect(classifyProviderError("Anthropic API request failed: HTTP 400: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.")).toBe("fatal");
  });

  it("classifies other account-level 4xx errors (401, 403, 404) as fatal", () => {
    expect(classifyProviderError("Anthropic API request failed: HTTP 401: invalid x-api-key")).toBe("fatal");
    expect(classifyProviderError("Anthropic API request failed: HTTP 403: permission denied")).toBe("fatal");
    expect(classifyProviderError("Anthropic API request failed: HTTP 404: not found")).toBe("fatal");
  });

  it("classifies 429 (rate limit) as transient", () => {
    expect(classifyProviderError("Anthropic API request failed: HTTP 429: rate limited")).toBe("transient");
  });

  it("classifies 5xx as transient", () => {
    expect(classifyProviderError("Anthropic API request failed: HTTP 503: overloaded")).toBe("transient");
  });

  it("classifies timeouts and network failures as transient", () => {
    expect(classifyProviderError("Anthropic API request timed out after 60 s")).toBe("transient");
    expect(classifyProviderError("Anthropic API request failed: fetch failed")).toBe("transient");
  });
});

describe("backoffDelayMs", () => {
  it("doubles each attempt starting at the base delay", () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
  });

  it("caps at the max delay", () => {
    expect(backoffDelayMs(10)).toBe(10_000);
  });
});

describe("checkStudyValidity", () => {
  it("is valid when the verifier succeeded (or merely skipped) for every PR", () => {
    const result = checkStudyValidity(0, 48);
    expect(result).toEqual({ invalid: false, failedCount: 0, scoredCount: 48, failedShare: 0 });
  });

  it("is valid when fewer than half of scored PRs had a verifier failure", () => {
    expect(checkStudyValidity(23, 48).invalid).toBe(false);
  });

  it("is invalid once the verifier failed open for a majority of scored PRs — this is the exact bug from the previous run (48/48 failed)", () => {
    const result = checkStudyValidity(48, 48);
    expect(result).toEqual({ invalid: true, failedCount: 48, scoredCount: 48, failedShare: 1 });
  });

  it("is invalid right at a bare majority (strictly more than half)", () => {
    expect(checkStudyValidity(25, 48).invalid).toBe(true);
    expect(checkStudyValidity(24, 48).invalid).toBe(false); // exactly half: not yet "most"
  });

  it("is invalid when nothing was ever scored (treated as no signal, not a clean pass)", () => {
    expect(checkStudyValidity(0, 0)).toEqual({ invalid: true, failedCount: 0, scoredCount: 0, failedShare: 1 });
  });
});

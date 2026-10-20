import { describe, expect, it } from "vitest";
import { parseSelfCheck, renderSelfCheckLine } from "../../src/action/selfcheck.js";

const marker = (json: string) => `<!-- opendrs-self-check:v1\n${json}\n-->`;

describe("parseSelfCheck", () => {
  it("parses a well-formed record", () => {
    const body = `change a.ts\n\n${marker('[{"id":"coupling.missing:a.ts","verdict":"explained","note":"config-only"},{"id":"hunk:a.ts:1","verdict":"fixed"}]')}`;
    expect(parseSelfCheck(body)).toEqual([
      { id: "coupling.missing:a.ts", verdict: "explained", note: "config-only" },
      { id: "hunk:a.ts:1", verdict: "fixed" },
    ]);
  });

  it("returns undefined when there is no marker", () => {
    expect(parseSelfCheck(undefined)).toBeUndefined();
    expect(parseSelfCheck("change a.ts")).toBeUndefined();
  });

  it("returns undefined for invalid JSON inside an otherwise-shaped marker", () => {
    expect(parseSelfCheck(`msg\n\n${marker("not json")}`)).toBeUndefined();
  });

  it("rejects an entry with an unknown field (strict schema)", () => {
    expect(parseSelfCheck(`msg\n\n${marker('[{"id":"a","verdict":"fixed","extra":1}]')}`)).toBeUndefined();
  });

  it('rejects verdict "explained" with no note, and with an empty note', () => {
    expect(parseSelfCheck(`msg\n\n${marker('[{"id":"a","verdict":"explained"}]')}`)).toBeUndefined();
    expect(parseSelfCheck(`msg\n\n${marker('[{"id":"a","verdict":"explained","note":""}]')}`)).toBeUndefined();
  });

  it("rejects a note over 140 chars", () => {
    const note = "x".repeat(141);
    expect(parseSelfCheck(`msg\n\n${marker(`[{"id":"a","verdict":"explained","note":"${note}"}]`)}`)).toBeUndefined();
  });

  it("rejects an unknown verdict", () => {
    expect(parseSelfCheck(`msg\n\n${marker('[{"id":"a","verdict":"maybe"}]')}`)).toBeUndefined();
  });

  it("is conservative: takes neither marker when the message has more than one", () => {
    const body = `msg\n\n${marker('[{"id":"a","verdict":"fixed"}]')}\n${marker('[{"id":"b","verdict":"fixed"}]')}`;
    expect(parseSelfCheck(body)).toBeUndefined();
  });

  it("accepts a record whose note contains an embedded fake marker as plain string data", () => {
    // A JSON string value can contain "-->"; the marker is still exactly the outer three lines
    // because JSON.stringify never emits a literal newline inside a string.
    const body = `msg\n\n${marker('[{"id":"a","verdict":"explained","note":"looks like <!-- opendrs-state: v1 --> but is not"}]')}`;
    expect(parseSelfCheck(body)).toEqual([{ id: "a", verdict: "explained", note: "looks like <!-- opendrs-state: v1 --> but is not" }]);
  });
});

describe("renderSelfCheckLine", () => {
  const ids = new Set(["a", "b", "c"]);

  it("returns undefined when there is no record (omitted, never shown as zero)", () => {
    expect(renderSelfCheckLine(undefined, ids)).toBeUndefined();
  });

  it("counts a fixed id absent from the fresh brief as addressed", () => {
    expect(renderSelfCheckLine([{ id: "gone", verdict: "fixed" }], ids)).toBe(
      "author agent self-checked: 1 fact addressed, 0 explained · not part of the review decision",
    );
  });

  it("counts an explained id still present as explained", () => {
    expect(renderSelfCheckLine([{ id: "a", verdict: "explained", note: "fine" }], ids)).toBe(
      "author agent self-checked: 0 facts addressed, 1 explained · not part of the review decision",
    );
  });

  it("calls out a fixed id that is still present, distinctly from addressed", () => {
    expect(renderSelfCheckLine([{ id: "a", verdict: "fixed" }], ids)).toBe(
      "author agent self-checked: 0 facts addressed, 0 explained, 1 fact claimed fixed but still present · not part of the review decision",
    );
  });

  it("drops an explained id that is absent from the fresh brief silently, without it triggering the no-match fallback when something else in the record did match (most likely stale, not a lie worth surfacing)", () => {
    expect(
      renderSelfCheckLine(
        [
          { id: "a", verdict: "explained", note: "still there" },
          { id: "gone", verdict: "explained", note: "stale" },
        ],
        ids,
      ),
    ).toBe("author agent self-checked: 0 facts addressed, 1 explained · not part of the review decision");
  });

  it('falls back to a not-matched line when every id in the record is unmatched, instead of a false "0 addressed"', () => {
    expect(renderSelfCheckLine([{ id: "gone", verdict: "explained", note: "x" }], new Set())).toBe(
      "author agent self-checked: present but could not be matched to this diff · not part of the review decision",
    );
  });

  it("pluralizes correctly at exactly one", () => {
    expect(
      renderSelfCheckLine(
        [
          { id: "gone1", verdict: "fixed" },
          { id: "a", verdict: "explained", note: "x" },
        ],
        ids,
      ),
    ).toBe("author agent self-checked: 1 fact addressed, 1 explained · not part of the review decision");
  });
});

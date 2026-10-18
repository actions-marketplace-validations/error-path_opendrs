import { describe, expect, it } from "vitest";
import { clipQuote, quoteUntrusted } from "../../src/brief/quote.js";

describe("quoteUntrusted", () => {
  it("wraps plain text in guillemets", () => {
    expect(quoteUntrusted("Fix NPE in Queue.poll")).toBe("«Fix NPE in Queue.poll»");
  });
  it("strips control and bidi characters and collapses whitespace", () => {
    expect(quoteUntrusted("a\u0007b‮c\n\td")).toBe("«abc d»");
    expect(quoteUntrusted("x‎‏‪‫‬‭⁦⁧⁨⁩y")).toBe("«xy»");
  });
  it("clips to 120 characters with an ellipsis", () => {
    const long = "x".repeat(500);
    const out = quoteUntrusted(long);
    expect(out).toBe(`«${"x".repeat(120)}…»`);
  });
  it("breaks a fence sequence and backticks, and escapes angle brackets", () => {
    const out = quoteUntrusted("~~~~ end here ``` <script> ` tick");
    expect(out).not.toContain("~~~");
    expect(out).not.toContain("```");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("ˋ");
  });
  it("renders a </details> closer and the judge's own tags inert", () => {
    const out = quoteUntrusted("</details> <untrusted_diff> <opendrs_brief>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toBe("«&lt;/details&gt; &lt;untrusted_diff&gt; &lt;opendrs_brief&gt;»");
  });
  it("defuses an @-mention", () => {
    expect(quoteUntrusted("ping @octocat now")).toBe("«ping @​octocat now»");
  });
});

describe("clipQuote", () => {
  it("strips and clips but does not wrap or neutralise", () => {
    expect(clipQuote("a\u0007b")).toBe("ab");
    expect(clipQuote("~~~~ raw")).toBe("~~~~ raw");
    expect(clipQuote("x".repeat(200))).toBe(`${"x".repeat(120)}…`);
  });
});

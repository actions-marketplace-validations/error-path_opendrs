import { describe, expect, it } from "vitest";
import { cell, code, untrusted } from "../../src/report/escape.js";

describe("escape helpers", () => {
  it("cell: one line, HTML and table syntax escaped", () => {
    expect(cell("a\nb | `c` <d> [e](f)")).toBe("a b \\| \\`c\\` &lt;d&gt; \\[e\\](f)");
  });
  it("code: backtick-safe inline code", () => {
    expect(code("a`b\nc")).toBe("`aˋb c`");
  });
  it("untrusted: cell-escaped, @-mentions defused", () => {
    expect(untrusted("hi @octocat")).toBe("hi @​octocat");
  });
});

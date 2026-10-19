import { describe, expect, it } from "vitest";
import { shortenWhy } from "../../src/brief/build.js";
import type { ArchitectureFact } from "../../src/domain/types.js";

function fact(partial: Partial<ArchitectureFact> & Pick<ArchitectureFact, "id" | "text">): ArchitectureFact {
  return { weight: "strong", file: "src/a.ts", ...partial };
}

describe("shortenWhy", () => {
  it("does not cut inside a backtick code span containing a file path with dots", () => {
    // Same shape contracts.ts produces for contract.api (Removes or changes exported X, imported by N files),
    // shortened so the whole sentence fits under the ~100-char budget and the fallback isn't triggered instead.
    const f = fact({
      id: "contract.api",
      text: "Removes `maybe_install_uvloop` (`src/black/concurrency.py:30`), imported by 3 files.",
    });
    const why = shortenWhy(f);
    expect(why).toBe("Removes `maybe_install_uvloop` (`src/black/concurrency.py:30`), imported by 3 files");
  });

  it("falls back to a fact-type summary instead of a near-100-char truncated sentence, on the exact real failing fact from the black.md field notes", () => {
    // field notes: "8b9d3e3/27c6fd0/f705197 all cut mid-filename (e.g. ... missing `.py:30`), imported by 3 files.)"
    const f = fact({
      id: "contract.api",
      text: "Removes or changes exported `maybe_install_uvloop` (`src/black/concurrency.py:30`), imported by 3 files.",
    });
    const why = shortenWhy(f);
    // Never the old bug's mid-path cut, and never bare/empty - it's over the ~100-char budget, so the
    // type-based fallback kicks in instead of a borderline-unreadable one-liner.
    expect(why).not.toContain("concurrency");
    expect(why).toBe("exported API change: maybe_install_uvloop");
  });

  it("does not split on a semicolon that falls inside a backtick code span", () => {
    const f = fact({
      id: "layers.edge",
      text: "`a;weird/path.ts` now imports `src/db` for the first time (`src/a.ts:5`).",
    });
    const why = shortenWhy(f);
    expect(why).toBe("`a;weird/path.ts` now imports `src/db` for the first time (`src/a.ts:5`)");
  });

  it("renders the real black.md failing example (a dotfile path right after the opening backtick) without truncating to bare backticks", () => {
    // d078e8e's contract.schema fact: path is `.github/workflows/cut_release.yml`, a '.' right after the opening backtick.
    const f = fact({
      id: "contract.schema",
      text: "Changes schema or contract file `.github/workflows/cut_release.yml`.",
    });
    const why = shortenWhy(f);
    expect(why).not.toBe("`");
    expect(why.length).toBeGreaterThan(1);
    expect(why).toBe("Changes schema or contract file `.github/workflows/cut_release.yml`");
  });

  it("falls back to a fact-type-based summary when the shortened text would still be longer than ~100 chars", () => {
    const f = fact({
      id: "layers.edge",
      text: "`src/api` now imports `src/db` for the first time (`src/api/handlers/very/long/nested/path/that/pushes/this/sentence/past/the/one/hundred/character/budget.ts:512`).",
    });
    const why = shortenWhy(f);
    expect(why).toBe("new import edge src/api → src/db");
  });

  it("falls back to a fact-type-based summary when the shortened text would be empty", () => {
    const f = fact({ id: "contract.env", text: ". leading separator with nothing before it" });
    const why = shortenWhy(f);
    expect(why).toBe("new environment variable in src/a.ts");
  });
});

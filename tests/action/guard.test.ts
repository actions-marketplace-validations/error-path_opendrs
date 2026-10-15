import { describe, expect, it } from "vitest";
import { selfModifiedPaths } from "../../src/action/guard.js";

describe("selfModifiedPaths", () => {
  it.each([
    ".opendrs.yml",
    ".opendrs/model.json",
    ".opendrs/incidents.jsonl",
    ".github/workflows/opendrs.yml",
    ".github/CODEOWNERS",
    "action.yml",
    "action.yaml",
    "action/dist/index.js",
    ".GitHub/workflows/x.yml",
    "Action.YML",
    ".gitmodules",
  ])("trips on %s", (path) => {
    expect(selfModifiedPaths(["src/a.ts", path])).toEqual([path]);
  });

  it.each(["src/a.ts", "docs/.github.md", "sub/.github/x.yml", "sub/action.yml", "actions/x.ts", ".opendrs.yml.bak", "README.md"])(
    "ignores %s",
    (path) => {
      expect(selfModifiedPaths([path])).toEqual([]);
    },
  );

  it("also guards extra paths such as a custom model location", () => {
    expect(selfModifiedPaths(["models/drs.json", "src/a.ts"], ["models/drs.json"])).toEqual(["models/drs.json"]);
  });

  it("cannot be disabled by passing no extra paths", () => {
    expect(selfModifiedPaths([".github/x"], [])).toEqual([".github/x"]);
  });
});

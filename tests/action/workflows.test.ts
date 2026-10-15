import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { WORKFLOW_TEMPLATE } from "../../src/cli/templates.js";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const docs = read("docs/github-action.md");

/** Every complete workflow (has `on:` and `jobs:`) shown in the Action docs. */
const docWorkflows = [...docs.matchAll(/```yaml\n([\s\S]*?)```/g)]
  .map((m) => m[1]!)
  .filter((y) => /^on:/m.test(y) && /^jobs:/m.test(y));

const workflows: Array<[string, string]> = [
  [".github/workflows/opendrs.yml", read(".github/workflows/opendrs.yml")],
  ["opendrs init template", WORKFLOW_TEMPLATE],
  ...docWorkflows.map((y, i): [string, string] => [`docs/github-action.md workflow ${i + 1}`, y]),
];

describe("workflows that run the Action", () => {
  it("the docs show at least the minimal and the AI-review workflow", () => {
    expect(docWorkflows.length).toBeGreaterThanOrEqual(2);
  });

  it.each(workflows)("%s cancels a run superseded by a newer push to the same PR", (_, text) => {
    expect(parse(text).concurrency).toEqual({ group: "opendrs-${{ github.event.pull_request.number }}", "cancel-in-progress": true });
  });

  it.each([...workflows, ["action.yml", read("action.yml")] as [string, string]])("%s never uses pull_request_target", (_, text) => {
    const on = parse(text).on ?? {};
    expect(Object.keys(on)).not.toContain("pull_request_target");
  });

  it("the docs warn against pull_request_target", () => {
    expect(docs).toMatch(/`pull_request_target`[^.]*secrets/);
  });
});

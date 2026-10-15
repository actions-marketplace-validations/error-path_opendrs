import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowIO } from "../../src/action/workflow.js";

let dir: string;
let written: string;
const write = (s: string) => void (written += s);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opendrs-wf-"));
  written = "";
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createWorkflowIO", () => {
  it("escapes workflow command data so a message cannot inject commands", () => {
    const io = createWorkflowIO({}, write);
    io.warning("100% bad\n::error::injected\r");
    expect(written).toBe("::warning::100%25 bad%0A::error::injected%0D\n");
  });

  it("prints untrusted text on one line that the runner cannot read as a command", () => {
    const io = createWorkflowIO({}, write);
    io.info("  - docs/x\n::stop-commands::pwned\r\n::notice title=opendrs::approved, all rails passed\r.md");
    io.info("::error::forged");
    io.info("  ::warning::forged");
    io.info("legacy ##[add-mask]secret");
    expect(written).toBe(
      "  - docs/x⏎::stop-commands::pwned⏎::notice title=opendrs::approved, all rails passed⏎.md\n" +
        "›::error::forged\n" +
        "  ›::warning::forged\n" +
        "legacy #›#[add-mask]secret\n",
    );
  });

  it("escapes a group name like command data", async () => {
    const io = createWorkflowIO({}, write);
    await io.group("a\n::stop-commands::x", async () => undefined);
    expect(written).toBe("::group::a%0A::stop-commands::x\n::endgroup::\n");
  });

  it("emits notice and error commands", () => {
    const io = createWorkflowIO({}, write);
    io.notice("hi");
    io.error("oops");
    expect(written).toBe("::notice::hi\n::error::oops\n");
  });

  it("wraps a group and closes it even when the body throws", async () => {
    const io = createWorkflowIO({}, write);
    await expect(io.group("Score", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(written).toBe("::group::Score\n::endgroup::\n");
  });

  it("appends outputs with a heredoc delimiter, safe for multi-line values", () => {
    const file = join(dir, "out");
    writeFileSync(file, "");
    const io = createWorkflowIO({ GITHUB_OUTPUT: file }, write);
    io.setOutput("score", "0.12");
    io.setOutput("tier", "a\nb");
    const text = readFileSync(file, "utf8");
    const parsed = [...text.matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2\n/gm)].map((m) => [m[1], m[3]]);
    expect(parsed).toEqual([
      ["score", "0.12"],
      ["tier", "a\nb"],
    ]);
  });

  it("appends to the step summary", () => {
    const file = join(dir, "summary");
    writeFileSync(file, "earlier\n");
    const io = createWorkflowIO({ GITHUB_STEP_SUMMARY: file }, write);
    io.summary("# opendrs");
    expect(readFileSync(file, "utf8")).toBe("earlier\n# opendrs\n");
  });

  it("does nothing for outputs and summary outside Actions", () => {
    const io = createWorkflowIO({}, write);
    io.setOutput("score", "1");
    io.summary("x");
    expect(written).toBe("");
  });
});

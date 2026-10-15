import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/cli.js";
import { VERSION } from "../../src/version.js";
import { testIo } from "./helpers.js";

describe("runCli", () => {
  it("prints the version", async () => {
    const t = testIo(process.cwd());
    expect(await runCli(["--version"], t.io)).toBe(0);
    expect(t.stdout()).toBe(VERSION);
  });

  it("prints global help listing every command", async () => {
    const t = testIo(process.cwd());
    expect(await runCli(["--help"], t.io)).toBe(0);
    for (const c of ["score", "explain", "calibrate", "backtest", "init", "mcp"]) expect(t.stdout()).toContain(c);
  });

  it("exits 2 with help when no command is given", async () => {
    const t = testIo(process.cwd());
    expect(await runCli([], t.io)).toBe(2);
    expect(t.stderr()).toContain("Usage: opendrs <command>");
  });

  it("exits 2 on an unknown command", async () => {
    const t = testIo(process.cwd());
    expect(await runCli(["frobnicate"], t.io)).toBe(2);
    expect(t.stderr()).toContain("unknown command 'frobnicate'");
  });

  it("prints per-command help with --help and with 'help <command>'", async () => {
    const a = testIo(process.cwd());
    expect(await runCli(["score", "--help"], a.io)).toBe(0);
    expect(a.stdout()).toContain("--fail-above");
    const b = testIo(process.cwd());
    expect(await runCli(["help", "backtest"], b.io)).toBe(0);
    expect(b.stdout()).toContain("--max-commits");
  });

  it("reports an unknown option as a usage error (exit 2, no stack)", async () => {
    const t = testIo(process.cwd());
    expect(await runCli(["score", "--bogus"], t.io)).toBe(2);
    expect(t.stderr()).toContain("opendrs score:");
    expect(t.stderr()).toContain("opendrs score --help");
    expect(t.stderr()).not.toContain("    at ");
  });
});

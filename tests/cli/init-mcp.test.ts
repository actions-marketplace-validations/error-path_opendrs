import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_BLOCK, DEFAULT_CRITICAL, DEFAULT_INSTRUCTIONS, defaultConfig, parseConfigText } from "../../src/domain/config.js";
import { runCli } from "../../src/cli/cli.js";
import { mcpCommand } from "../../src/cli/commands/mcp.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { testIo } from "./helpers.js";

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
  repo.commit({ "a.ts": "1\n" }, "init");
});
afterEach(() => repo.cleanup());

describe("opendrs init", () => {
  it("writes a .opendrs.yml that parses to exactly the defaults", async () => {
    expect(await runCli(["init"], testIo(repo.dir).io)).toBe(0);
    const text = readFileSync(join(repo.dir, ".opendrs.yml"), "utf8");
    expect(parseConfigText(text)).toEqual(defaultConfig());
    expect(text).toMatch(/^\s*#/m);
  });

  it("lists every default block, critical and instructions glob (user lists extend the defaults, so parsing alone cannot tell)", async () => {
    await runCli(["init"], testIo(repo.dir).io);
    const raw = parse(readFileSync(join(repo.dir, ".opendrs.yml"), "utf8"));
    expect(raw.paths.block).toEqual(DEFAULT_BLOCK);
    expect(raw.paths.critical).toEqual(DEFAULT_CRITICAL);
    expect(raw.paths.instructions).toEqual(DEFAULT_INSTRUCTIONS);
    expect(raw.paths.unblock).toEqual([]);
  });

  it("writes a commented sizeCapExempt example that does not change the parsed defaults", async () => {
    await runCli(["init"], testIo(repo.dir).io);
    const text = readFileSync(join(repo.dir, ".opendrs.yml"), "utf8");
    expect(text).toMatch(/#\s*sizeCapExempt:/);
    expect(parseConfigText(text)).toEqual(defaultConfig());
  });

  it("writes a comment-only workflow with full history", async () => {
    await runCli(["init"], testIo(repo.dir).io);
    const wf = parse(readFileSync(join(repo.dir, ".github/workflows/opendrs.yml"), "utf8"));
    expect(Object.keys(wf.on)).toEqual(["pull_request"]);
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "write", checks: "read" });
    const steps = wf.jobs.opendrs.steps;
    expect(steps[0].with["fetch-depth"]).toBe(0);
    expect(steps[1].uses).toMatch(/^error-path\/opendrs@/);
  });

  it("creates nothing under .opendrs/ (a committed cache or stray file there hard-blocks every PR)", async () => {
    expect(await runCli(["init"], testIo(repo.dir).io)).toBe(0);
    expect(existsSync(join(repo.dir, ".opendrs"))).toBe(false);
  });

  it("does not overwrite existing files without --force", async () => {
    writeFileSync(join(repo.dir, ".opendrs.yml"), "mine: true\n");
    const t = testIo(repo.dir);
    expect(await runCli(["init"], t.io)).toBe(0);
    expect(readFileSync(join(repo.dir, ".opendrs.yml"), "utf8")).toBe("mine: true\n");
    expect(t.stdout()).toContain("--force");
    expect(existsSync(join(repo.dir, ".github/workflows/opendrs.yml"))).toBe(true);
  });

  it("overwrites with --force", async () => {
    writeFileSync(join(repo.dir, ".opendrs.yml"), "mine: true\n");
    await runCli(["init", "--force"], testIo(repo.dir).io);
    expect(parseConfigText(readFileSync(join(repo.dir, ".opendrs.yml"), "utf8"))).toEqual(defaultConfig());
  });
});

describe("opendrs mcp", () => {
  it("runs the MCP server from the lazily loaded module", async () => {
    const runMcpServer = vi.fn(async () => {});
    const t = testIo(repo.dir);
    expect(await mcpCommand(async () => ({ runMcpServer })).run([], t.io)).toBe(0);
    expect(runMcpServer).toHaveBeenCalledOnce();
  });

  it("prints an error and exits 2 when the server module cannot be loaded", async () => {
    const t = testIo(repo.dir);
    const code = await mcpCommand(async () => {
      throw new Error("Cannot find module '../mcp/server.js'");
    }).run([], t.io);
    expect(code).toBe(2);
    expect(t.stderr()).toContain("MCP server is not available");
  });
});

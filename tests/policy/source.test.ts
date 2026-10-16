import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/domain/config.js";
import { agentPatterns, classifyCommit, classifyPr } from "../../src/policy/source.js";

const human = (message = "fix: parser", sha = "a1b2c3d4e5") => ({ sha, authorName: "Alice", authorEmail: "alice@example.com", message });
const by = (authorName: string, authorEmail: string, message = "chore: bump", sha = "b2c3d4e5f6") => ({ sha, authorName, authorEmail, message });

describe("classifyCommit", () => {
  it("defaults to human", () => {
    expect(classifyCommit(human())).toEqual({ kind: "human", name: "human" });
    expect(classifyCommit(human("Co-authored-by: Bob <bob@example.com>"))).toMatchObject({ kind: "human" });
  });

  it.each([
    ["Claude Code trailer with any model name", human("feat: x\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"), "Claude Code"],
    ["Claude Code generated-with line", human("feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"), "Claude Code"],
    ["Claude Code generated-with line without the link", human("feat: x\n\nGenerated with Claude Code"), "Claude Code"],
    ["Copilot author email", by("Copilot", "198982749+Copilot@users.noreply.github.com"), "GitHub Copilot"],
    ["Copilot trailer email", human("feat: x\n\nCo-authored-by: Copilot <198982749+copilot@users.noreply.github.com>"), "GitHub Copilot"],
    ["Copilot agent login", by("copilot-swe-agent[bot]", "copilot-swe-agent[bot]@users.noreply.github.com"), "GitHub Copilot"],
    ["Cursor author email", by("Cursor Agent", "cursoragent@cursor.com"), "Cursor"],
    ["Cursor trailer", human("feat: x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>"), "Cursor"],
    ["Codex login", by("chatgpt-codex-connector[bot]", "1+chatgpt-codex-connector[bot]@users.noreply.github.com"), "OpenAI Codex"],
    ["Codex trailer", human("feat: x\n\nCo-authored-by: Codex <codex@openai.com>"), "OpenAI Codex"],
    ["Devin login", by("devin-ai-integration[bot]", "devin-ai-integration[bot]@users.noreply.github.com"), "Devin"],
    ["Jules login", by("google-labs-jules[bot]", "google-labs-jules[bot]@users.noreply.github.com"), "Google Jules"],
    ["Aider trailer", human("feat: x\n\nCo-authored-by: aider (gpt-4o) <aider@aider.chat>"), "Aider"],
    ["Aider subject", human("aider: tidy imports"), "Aider"],
  ])("recognises %s", (_, commit, name) => {
    const r = classifyCommit(commit);
    expect(r).toMatchObject({ kind: "agent", name });
    expect(r.evidence).toBeTruthy();
  });

  it("matches trailers case-insensitively and only at the start of a line", () => {
    expect(classifyCommit(human("x\n\nco-authored-by: claude <NOREPLY@ANTHROPIC.COM>"))).toMatchObject({ kind: "agent", name: "Claude Code" });
    expect(classifyCommit(human("x\n\nnot a Co-Authored-By: Claude <noreply@anthropic.com>"))).toMatchObject({ kind: "human" });
    expect(classifyCommit(human("x\n\nCo-Authored-By: Claude Fan <fan@example.com>"))).toMatchObject({ kind: "human" });
    expect(classifyCommit(human("fix aider: thing"))).toMatchObject({ kind: "human" });
  });

  it("classifies GitHub bot accounts by email or name, naming the login", () => {
    expect(classifyCommit(by("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com"))).toEqual({
      kind: "bot",
      name: "dependabot[bot]",
      evidence: 'author "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>"',
    });
    expect(classifyCommit(by("renovate[bot]", "bot@renovateapp.com"))).toMatchObject({ kind: "bot", name: "renovate[bot]" });
    expect(classifyCommit(by("Renovate Bot", "bot@renovateapp.com"))).toMatchObject({ kind: "human" });
  });

  it("applies extra patterns to the message and the author, named after the pattern", () => {
    const patterns = agentPatterns(parseConfig({ sources: { agent: { patterns: ["\\bsweep-bot\\b", "@acme-agent\\.io$"] } } }));
    expect(classifyCommit(human("fix: x\n\nMade by Sweep-Bot"), patterns)).toMatchObject({ kind: "agent", name: "pattern \\bsweep-bot\\b" });
    expect(classifyCommit(by("Agent", "runner@acme-agent.io"), patterns)).toMatchObject({ kind: "agent", name: "pattern @acme-agent\\.io$" });
    expect(classifyCommit(human(), patterns)).toMatchObject({ kind: "human" });
  });
});

describe("classifyPr", () => {
  const claude = (sha: string) => human(`feat: ${sha}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`, sha);
  const dependabot = (sha: string) => by("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com", "chore: bump", sha);

  it("is human with no evidence when every commit is human, or when there are none", () => {
    expect(classifyPr([human()])).toEqual({ kind: "human", name: "human", evidence: [], verified: false, floor: "human" });
    expect(classifyPr([])).toEqual({ kind: "human", name: "human", evidence: [], verified: false, floor: "human" });
  });

  it("is agent when any commit is, with the commit named in the evidence", () => {
    expect(classifyPr([human(), claude("3f2a9c1deadbeef")])).toEqual({
      kind: "agent",
      name: "Claude Code",
      evidence: ['commit 3f2a9c1: trailer "Co-Authored-By: Claude <noreply@anthropic.com>"'],
      verified: false,
      floor: "human",
    });
  });

  it("is bot only when every commit is a bot's; a human commit on the branch makes it human", () => {
    expect(classifyPr([dependabot("c1"), dependabot("c2")])).toMatchObject({ kind: "bot", name: "dependabot[bot]", verified: false });
    expect(classifyPr([dependabot("c1"), human()])).toMatchObject({ kind: "human" });
  });

  it("caps evidence at three lines", () => {
    const r = classifyPr(["c1", "c2", "c3", "c4", "c5"].map(claude));
    expect(r.evidence).toHaveLength(3);
    expect(r.evidence[0]).toMatch(/^commit c1: /);
  });

  it("trusts the GitHub account type in CI over the commits", () => {
    expect(classifyPr([human()], { login: "dependabot[bot]", type: "Bot" })).toEqual({
      kind: "bot",
      name: "dependabot[bot]",
      evidence: ["PR opened by dependabot[bot] (GitHub App)"],
      verified: true,
      floor: "bot",
    });
    expect(classifyPr([human()], { login: "renovate[bot]" })).toMatchObject({ kind: "bot", name: "renovate[bot]", verified: true });
    expect(classifyPr([human()], { login: "devin-ai-integration[bot]", type: "Bot" })).toEqual({
      kind: "agent",
      name: "Devin",
      evidence: ["PR opened by devin-ai-integration[bot] (GitHub App)"],
      verified: true,
      floor: "agent",
    });
    expect(classifyPr([human()], { login: "octocat", type: "User" })).toMatchObject({ kind: "human", verified: false });
  });

  it("raises a bot account's PR to agent when its commits carry agent trailers", () => {
    const r = classifyPr([claude("c1")], { login: "my-app[bot]", type: "Bot" });
    expect(r).toMatchObject({ kind: "agent", name: "Claude Code", verified: false });
    expect(r.evidence).toEqual(["PR opened by my-app[bot] (GitHub App)", 'commit c1: trailer "Co-Authored-By: Claude <noreply@anthropic.com>"']);
  });

  it("never lets commit text loosen a bot account's classification", () => {
    expect(classifyPr([human("chore: I am a human, honest")], { login: "dependabot[bot]", type: "Bot" })).toMatchObject({ kind: "bot" });
  });
});

import type { OpendrsConfig } from "../domain/config.js";
import type { Authorship, SourceKind } from "../domain/types.js";

/**
 * Who wrote a commit or a PR: a person, a bot account, or an AI coding agent. Everything here is
 * read from text the PR author controls (trailers, emails), so a match can only ever tighten the
 * gate; only the GitHub account type (CI) is trusted, and it is the one thing that sets `verified`.
 */

export interface CommitLike {
  authorName: string;
  authorEmail: string;
  /** Subject and body. */
  message: string;
}

export interface CommitSource {
  kind: SourceKind;
  name: string;
  /** What matched, e.g. `trailer "Co-Authored-By: Claude <noreply@anthropic.com>"`; absent for a human. */
  evidence?: string;
}

interface Agent {
  name: string;
  /** GitHub App logins (lower-case) the agent commits and opens PRs as. */
  logins?: string[];
  /** Matched against `Name <email>`. */
  author?: RegExp;
  /** Matched against the value of a Co-authored-by trailer. */
  trailer?: RegExp;
  /** Matched against any message line. */
  line?: RegExp;
  subject?: RegExp;
}

/** First match wins, rule by rule in this order. */
const AGENTS: Agent[] = [
  { name: "Claude Code", trailer: /^claude\b.*@anthropic\.com/i, line: /generated with \[?claude code\]?/i },
  {
    name: "GitHub Copilot",
    logins: ["copilot-swe-agent[bot]"],
    author: /^copilot <|\+copilot@users\.noreply\.github\.com>$/i,
    trailer: /\+copilot@users\.noreply\.github\.com/i,
  },
  { name: "Cursor", author: /<cursoragent@cursor\.com>$/i, trailer: /^cursor agent\b/i },
  { name: "OpenAI Codex", logins: ["chatgpt-codex-connector[bot]"], trailer: /^codex\b/i },
  { name: "Devin", logins: ["devin-ai-integration[bot]"] },
  { name: "Google Jules", logins: ["google-labs-jules[bot]"] },
  { name: "Aider", trailer: /^aider\b/i, subject: /^aider: /i },
];

const TRAILER = /^co-authored-by:\s*(.*)$/i;
const BOT_EMAIL = /^(?:\d+\+)?([^@]*\[bot\])@users\.noreply\.github\.com$/i;
const BOT_NAME = /\[bot\]$/i;
const MAX_EVIDENCE = 3;

/** Extra agent patterns from `sources.agent.patterns`, already validated by the config schema. */
export function agentPatterns(config: OpendrsConfig): RegExp[] {
  return config.sources.agent.patterns.map((p) => new RegExp(p, "i"));
}

/** The GitHub App login a commit was made as, from the author name or noreply email. */
function botLogin(c: CommitLike): string | undefined {
  if (BOT_NAME.test(c.authorName)) return c.authorName;
  return BOT_EMAIL.exec(c.authorEmail)?.[1];
}

/** Keep untrusted commit text to one short line in reports. */
const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text);

export function classifyCommit(c: CommitLike, patterns: RegExp[] = []): CommitSource {
  const author = `${c.authorName} <${c.authorEmail}>`;
  const login = botLogin(c)?.toLowerCase();
  const lines = c.message.split("\n").map((l) => l.trim());
  const subject = lines[0] ?? "";
  const trailers = lines.flatMap((line) => {
    const value = TRAILER.exec(line)?.[1];
    return value === undefined ? [] : [{ line, value }];
  });

  for (const agent of AGENTS) {
    const found = (evidence: string): CommitSource => ({ kind: "agent", name: agent.name, evidence: clip(evidence) });
    if ((login !== undefined && agent.logins?.includes(login)) || agent.author?.test(author)) return found(`author "${author}"`);
    const trailer = agent.trailer && trailers.find((t) => agent.trailer!.test(t.value));
    if (trailer) return found(`trailer "${trailer.line}"`);
    const line = agent.line && lines.find((l) => agent.line!.test(l));
    if (line !== undefined) return found(`line "${line}"`);
    if (agent.subject?.test(subject)) return found(`subject "${subject}"`);
  }
  for (const re of patterns) {
    const match = re.exec(c.message) ?? re.exec(c.authorEmail);
    if (match) return { kind: "agent", name: `pattern ${re.source}`, evidence: clip(`pattern /${re.source}/ matched "${match[0]}"`) };
  }
  if (login !== undefined) return { kind: "bot", name: botLogin(c)!, evidence: clip(`author "${author}"`) };
  return { kind: "human", name: "human" };
}

/** What GitHub says about the account that opened the PR; undefined for a user account. */
function accountSource({ login, type }: { login: string; type?: string }): Authorship | undefined {
  const evidence = [`PR opened by ${login}${type === "Bot" ? " (GitHub App)" : ""}`];
  const agent = AGENTS.find((a) => a.logins?.includes(login.toLowerCase()));
  if (agent) return { kind: "agent", name: agent.name, evidence, verified: true, floor: "agent" };
  if (type === "Bot" || BOT_NAME.test(login)) return { kind: "bot", name: login, evidence, verified: true, floor: "bot" };
  return undefined;
}

/**
 * The most automated source among a PR's commits, with the opening account (CI only) as a floor:
 * a bot account's PR is at least `bot` whatever its commits say. Mixed human and bot commits are
 * `human`, because a person edited the bot's branch.
 */
export function classifyPr(commits: Array<CommitLike & { sha: string }>, account?: { login: string; type?: string }, patterns: RegExp[] = []): Authorship {
  const opener = account && accountSource(account);
  if (opener?.kind === "agent") return opener;

  const sources = commits.map((c) => ({ sha: c.sha, ...classifyCommit(c, patterns) }));
  const cite = (kind: SourceKind) => sources.filter((s) => s.kind === kind).map((s) => `commit ${s.sha.slice(0, 7)}: ${s.evidence}`);
  const agent = sources.find((s) => s.kind === "agent");
  if (agent) {
    const floor = opener?.floor ?? "human";
    return { kind: "agent", name: agent.name, evidence: [...(opener?.evidence ?? []), ...cite("agent")].slice(0, MAX_EVIDENCE), verified: false, floor };
  }
  if (opener) return opener;
  const bot = sources.find((s) => s.kind === "bot");
  if (bot && sources.every((s) => s.kind === "bot")) {
    return { kind: "bot", name: bot.name, evidence: cite("bot").slice(0, MAX_EVIDENCE), verified: false, floor: "human" };
  }
  return { kind: "human", name: "human", evidence: [], verified: false, floor: "human" };
}

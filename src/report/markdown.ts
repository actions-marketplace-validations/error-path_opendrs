import type { Contribution, Decision, LlmJudgement, ScoreResult, Tier } from "../domain/types.js";

const MARKER = "<!-- opendrs -->";
const PROJECT_URL = "https://github.com/error-path/opendrs";
const TOP_CONTRIBUTIONS = 6;
const MAX_UNKNOWNS = 5;
const MAX_SNIPPETS = 3;
const MAX_RATIONALE = 400;

const TIER_EMOJI: Record<Tier, string> = { green: "🟢", yellow: "🟡", red: "🔴" };
const DECISION_TEXT: Record<Decision, string> = {
  "auto-approve": "auto-approve",
  "waiting-ai-review": "waiting for AI review",
  "human-review": "human review",
};

/** Inline text for a table cell or list item: one line, no raw HTML, links, code spans or table breakouts. */
export const cell = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\|`[\]]/g, "\\$&")
    .trim();
/** Untrusted text as inline code, where HTML, links and mentions are inert; only a backtick could end it. */
const code = (text: string) => `\`${text.replace(/\s+/g, " ").replace(/`/g, "ˋ").trim()}\``;
/** LLM output is shaped by the (untrusted) diff, so also stop it from @-mentioning people. */
const untrusted = (text: string) => cell(text).replace(/@(?=\w)/g, "@\u200b");
/** Terminal text: drop control characters so a summary cannot inject escape sequences. */
const plain = (text: string) => text.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();

const signed = (n: number, minus: string) => `${n < 0 ? minus : "+"}${Math.abs(n).toFixed(2)}`;
const top = (contributions: Contribution[]) => contributions.filter((c) => c.contribution !== 0).slice(0, TOP_CONTRIBUTIONS);
const short = (sha: string) => sha.slice(0, 7);
const clip = (text: string) => (text.length > MAX_RATIONALE ? `${text.slice(0, MAX_RATIONALE)}…` : text);

/** "3 safe (tests 2, docs 1), 2 risky": the judge's hunk verdicts, safe ones broken down by category. */
function hunkCounts(llm: LlmJudgement): string {
  const safe = llm.hunks.filter((h) => h.safe);
  const byCategory = new Map<string, number>();
  for (const h of safe) byCategory.set(h.category, (byCategory.get(h.category) ?? 0) + 1);
  const breakdown = safe.length > 0 ? ` (${[...byCategory].map(([c, n]) => `${c} ${n}`).join(", ")})` : "";
  return `${safe.length} safe${breakdown}, ${llm.hunks.length - safe.length} risky`;
}

/** PR comment body. Starts with the `<!-- opendrs -->` marker. */
export function renderMarkdown(result: ScoreResult): string {
  const { policy, diff } = result;
  const summaryOf = (id: string) => result.signals.find((s) => s.id === id)?.summary ?? "not reported; model prior used";
  const lines = [
    MARKER,
    `### ${TIER_EMOJI[result.tier]} Diff risk ${result.score.toFixed(2)} · ${result.tier} · ${DECISION_TEXT[policy.decision]}`,
    `<sub>${diff.files} files · +${diff.added} −${diff.deleted} · \`${short(diff.base)}…${short(diff.head)}\`</sub>`,
    "",
  ];

  const rows = top(result.contributions);
  if (rows.length > 0) {
    lines.push("| Signal | Value | Push | Why |", "|---|--:|--:|---|");
    for (const c of rows) lines.push(`| \`${c.id}\` | ${c.value.toFixed(2)} | ${signed(c.contribution, "−")} | ${cell(summaryOf(c.id))} |`);
    lines.push("");
  }

  if (result.unknowns.length > 0) {
    lines.push("**Unknowns** (counted as risk, not as zero)");
    for (const id of result.unknowns.slice(0, MAX_UNKNOWNS)) lines.push(`- \`${id}\`: ${cell(summaryOf(id))}`);
    if (result.unknowns.length > MAX_UNKNOWNS) lines.push(`- …and ${result.unknowns.length - MAX_UNKNOWNS} more`);
    lines.push("");
  }

  lines.push("**Policy**", ...policy.reasons.map((r) => `- ${cell(r)}`), "");

  if (policy.suggestedReviewers.length > 0) {
    lines.push(`**Suggested reviewers:** ${policy.suggestedReviewers.map(code).join(", ")}`, "");
  }

  if (result.llm) {
    lines.push(`<details><summary>LLM review (p=${result.llm.risk.toFixed(2)})</summary>`, "", `> ${untrusted(clip(result.llm.rationale))}`, "");
    for (const s of result.llm.riskySnippets.slice(0, MAX_SNIPPETS)) {
      lines.push(`- ${code(`${s.file}${s.line !== undefined ? `:${s.line}` : ""}`)} ${untrusted(s.reason)}`);
    }
    lines.push("", `Hunks: ${hunkCounts(result.llm)}`, "");
    for (const h of result.llm.hunks.filter((h) => !h.safe).slice(0, MAX_SNIPPETS)) {
      lines.push(`- ${code(`${h.file}:${h.line}`)} — ${h.category} (${h.confidence}/10): ${untrusted(h.reason)}`);
    }
    lines.push("", "</details>", "");
  }

  lines.push(`<sub>opendrs ${result.version} · ${result.model} model · [${PROJECT_URL.replace("https://", "")}](${PROJECT_URL})</sub>`);
  return `${lines.join("\n")}\n`;
}

/** Short human text for terminals. */
export function renderText(result: ScoreResult): string {
  const { policy, diff } = result;
  const lines = [
    `opendrs risk ${result.score.toFixed(2)}  ${result.tier.toUpperCase()}  -> ${DECISION_TEXT[policy.decision]}`,
    `${diff.files} files, +${diff.added} -${diff.deleted} (${short(diff.base)}..${short(diff.head)}), ${result.model} model, opendrs ${result.version}`,
  ];

  const rows = top(result.contributions);
  if (rows.length > 0) {
    const width = Math.max(...rows.map((c) => c.id.length));
    lines.push("", "Top contributions (push on the logit):");
    for (const c of rows) {
      const summary = result.signals.find((s) => s.id === c.id)?.summary ?? "model prior";
      lines.push(`  ${signed(c.contribution, "-").padStart(6)}  ${c.id.padEnd(width)}  ${plain(summary)}`);
    }
  }
  if (result.unknowns.length > 0) lines.push("", `Unknowns (counted as risk): ${result.unknowns.join(", ")}`);
  lines.push("", "Policy:", ...policy.reasons.map((r) => `  - ${plain(r)}`));
  if (policy.suggestedReviewers.length > 0) lines.push(`Reviewers: ${policy.suggestedReviewers.join(", ")}`);
  if (result.llm) lines.push(`LLM (p=${result.llm.risk.toFixed(2)}; hunks: ${hunkCounts(result.llm)}): ${plain(clip(result.llm.rationale))}`);
  return `${lines.join("\n")}\n`;
}

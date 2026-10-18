import { stripInvisible } from "../report/escape.js";

// The spec §7 pipeline for untrusted free text (commit subjects, author names, incident notes, the
// judge's reasons). File paths are not quoted here: they render as inline code via report/escape.ts.

const MAX_QUOTE = 120;

function stripAndClip(raw: string): string {
  // Whitespace first: a newline or tab is a control character too, and must become a space, not vanish.
  const stripped = stripInvisible(raw.replace(/\s+/g, " ")).trim();
  return stripped.length > MAX_QUOTE ? `${stripped.slice(0, MAX_QUOTE)}…` : stripped;
}

/** §7 steps 1-2: control/bidi characters removed, whitespace collapsed, clipped to 120 chars. For the raw `quote` field. */
export const clipQuote = (raw: string): string => stripAndClip(raw);

/** §7 steps 1-5: stripAndClip, then fence/backtick/angle-bracket/guillemet/@-mention neutralised, wrapped in «». For rendered text. */
export function quoteUntrusted(raw: string): string {
  const neutralised = stripAndClip(raw)
    .replace(/«/g, "‹")
    .replace(/»/g, "›")
    .replace(/`/g, "ˋ")
    .replace(/~~~/g, "~~‌~")
    .replace(/```/g, "``‌`")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=\w)/g, "@​");
  return `«${neutralised}»`;
}

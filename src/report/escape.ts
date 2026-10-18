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
export const code = (text: string) => `\`${text.replace(/\s+/g, " ").replace(/`/g, "ˋ").trim()}\``;
/** LLM output is shaped by the (untrusted) diff, so also stop it from @-mentioning people. */
export const untrusted = (text: string) => cell(text).replace(/@(?=\w)/g, "@​");

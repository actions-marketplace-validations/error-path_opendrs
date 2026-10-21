import { test } from "node:test";
import assert from "node:assert/strict";
import { indexNowUrls } from "./indexnow-urls.mjs";

const P = "https://example.test/site/";
const sm = (entries) =>
  `<urlset>${entries.map(([l, m]) => `<url><loc>${l}</loc>${m ? `<lastmod>${m}</lastmod>` : ""}</url>`).join("")}</urlset>`;

test("added, changed and removed URLs are listed; unchanged ones are not", () => {
  const before = sm([[`${P}a.html`, "2026-10-01"], [`${P}b.html`, "2026-10-01"], [`${P}gone.html`, "2026-10-01"]]);
  const after = sm([[`${P}a.html`, "2026-10-01"], [`${P}b.html`, "2026-10-21"], [`${P}new.html`, "2026-10-21"]]);
  assert.deepEqual(indexNowUrls(before, after, "", P).sort(), [`${P}b.html`, `${P}gone.html`, `${P}new.html`]);
});

test("an old sitemap without lastmod makes every page count as changed", () => {
  const before = sm([[`${P}a.html`], [`${P}b.html`]]);
  const after = sm([[`${P}a.html`, "2026-10-21"], [`${P}b.html`, "2026-10-21"]]);
  assert.deepEqual(indexNowUrls(before, after, "", P).sort(), [`${P}a.html`, `${P}b.html`]);
});

test("an empty or missing old sitemap submits every page", () => {
  assert.deepEqual(indexNowUrls("", sm([[`${P}a.html`, "2026-10-21"]]), "", P), [`${P}a.html`]);
});

test("nothing changed means an empty list", () => {
  const same = sm([[`${P}a.html`, "2026-10-21"]]);
  assert.deepEqual(indexNowUrls(same, same, "", P), []);
});

test("extra URLs tolerate blank lines, CRLF and tabs, and are deduplicated", () => {
  const same = sm([[`${P}a.html`, "2026-10-21"]]);
  const extra = `\r\n${P}x.html\r\n\t${P}y.html  ${P}x.html\n\n`;
  assert.deepEqual(indexNowUrls(same, same, extra, P), [`${P}x.html`, `${P}y.html`]);
});

test("an extra URL outside the prefix throws", () => {
  assert.throws(() => indexNowUrls("", "", "https://evil.test/a.html", P), /extra URL outside/);
});

test("entities in loc are decoded", () => {
  assert.deepEqual(indexNowUrls("", sm([[`${P}a&amp;b.html`, "2026-10-21"]]), "", P), [`${P}a&b.html`]);
});

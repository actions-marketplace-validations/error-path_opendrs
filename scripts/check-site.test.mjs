import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkSite, resolveInternal } from "./check-site.mjs";

const PREFIX = "https://example.test/site/";

function page({ title, description = `${title} description`, canonical, body = "", head = "", h1 = title }) {
  return `<!doctype html><html><head><title>${title}</title>
<meta name="description" content="${description}" />
<link rel="canonical" href="${canonical}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="//fonts.googleapis.com/css2?family=Geist">${head}</head>
<body><a class="skip" href="#main">Skip</a>
<nav><a href="/site/">Home</a> <a href="/site/a.html">A</a> <a href="/site/research/">Research</a> <a href="mailto:x@example.test">Mail</a></nav>
<main id="main"><h1 id="top">${h1}</h1>${body}</main></body></html>`;
}

function sitemap(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${entries
    .map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`)
    .join("")}</urlset>`;
}

function cleanSite() {
  return {
    "index.html": page({ title: "Home", canonical: PREFIX,
      head: `<script type="application/ld+json">{"@type":"WebSite"}</script>` }),
    "a.html": page({ title: "Page A", canonical: `${PREFIX}a.html`,
      body: `<p><a href="research/#top">notes</a> <a href="/site">home</a> <a href="my%20file.html">spaced</a></p>` }),
    "my file.html": page({ title: "Spaced", canonical: `${PREFIX}my%20file.html` }),
    "research/index.html": page({ title: "Research", canonical: `${PREFIX}research/` }),
    "sitemap.xml": sitemap([
      [PREFIX, "2026-10-20T10:00:00+05:30"],
      [`${PREFIX}a.html`, "2026-10-19T10:00:00+05:30"],
      [`${PREFIX}research/`, "2026-10-18T10:00:00+05:30"],
    ]),
    "llms.txt": `- [A](${PREFIX}a.html). See also ${PREFIX}research/, and https://github.com/x.`,
  };
}

function check(overrides = {}) {
  const files = { ...cleanSite(), ...overrides };
  const dir = mkdtempSync(join(tmpdir(), "check-site-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return checkSite(dir, PREFIX);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hasRule = (problems, rule) => problems.some((p) => p.includes(`: ${rule}: `));

test("a clean site passes", () => {
  assert.deepEqual(check(), []);
});

test("resolveInternal ignores external, protocol-relative and mailto links", () => {
  assert.equal(resolveInternal("https://github.com/x", "a.html", PREFIX), null);
  assert.equal(resolveInternal("//fonts.googleapis.com/css", "a.html", PREFIX), null);
  assert.equal(resolveInternal("mailto:x@example.test", "a.html", PREFIX), null);
  assert.equal(resolveInternal("https://example.test/other/", "a.html", PREFIX), null);
});

test("resolveInternal maps directories, the bare prefix and fragments", () => {
  assert.deepEqual(resolveInternal("research/", "a.html", PREFIX), { path: "research/index.html", fragment: "" });
  assert.deepEqual(resolveInternal("/site", "a.html", PREFIX), { path: "index.html", fragment: "" });
  assert.deepEqual(resolveInternal("#main", "research/index.html", PREFIX), { path: "research/index.html", fragment: "main" });
  assert.deepEqual(resolveInternal("../a.html?x=1#top", "research/index.html", PREFIX), { path: "a.html", fragment: "top" });
});

test("link: a missing target is reported", () => {
  const p = check({ "a.html": page({ title: "Page A", canonical: `${PREFIX}a.html`, body: `<a href="gone.html">x</a>` }) });
  assert.ok(hasRule(p, "link"), p.join("\n"));
});

test("link: a missing fragment id is reported", () => {
  const p = check({ "a.html": page({ title: "Page A", canonical: `${PREFIX}a.html`, body: `<a href="research/#nope">x</a>` }) });
  assert.ok(hasRule(p, "link"), p.join("\n"));
});

test("sitemap: a missing lastmod is reported", () => {
  const p = check({ "sitemap.xml": sitemap([[PREFIX, "2026-10-20"], [`${PREFIX}a.html`, ""], [`${PREFIX}research/`, "2026-10-18"]]) });
  assert.ok(hasRule(p, "sitemap"), p.join("\n"));
});

test("sitemap: an internal page is reported", () => {
  const p = check({
    "superpowers/plans/x.html": page({ title: "Plan", canonical: `${PREFIX}superpowers/plans/x.html` }),
    "sitemap.xml": sitemap([[PREFIX, "2026-10-20"], [`${PREFIX}a.html`, "2026-10-19"], [`${PREFIX}research/`, "2026-10-18"], [`${PREFIX}superpowers/plans/x.html`, "2026-10-18"]]),
  });
  assert.ok(p.some((x) => x.includes("sitemap: ") && x.includes("internal")), p.join("\n"));
});

test("sitemap: entities in loc are decoded", () => {
  const p = check({
    "a&b.html": page({ title: "Amp", canonical: `${PREFIX}a&amp;b.html` }),
    "a.html": page({ title: "Page A", canonical: `${PREFIX}a.html`, body: `<a href="research/#top">n</a> <a href="a&amp;b.html">amp</a>` }),
    "sitemap.xml": sitemap([[PREFIX, "2026-10-20"], [`${PREFIX}a.html`, "2026-10-19"], [`${PREFIX}research/`, "2026-10-18"], [`${PREFIX}a&amp;b.html`, "2026-10-18"]]),
  });
  assert.deepEqual(p, []);
});

test("title: a duplicate title is reported", () => {
  const p = check({ "research/index.html": page({ title: "Page A", description: "other", canonical: `${PREFIX}research/` }) });
  assert.ok(hasRule(p, "title"), p.join("\n"));
});

test("description: a missing or duplicate description is reported", () => {
  const missing = check({ "research/index.html": page({ title: "Research", description: "", canonical: `${PREFIX}research/` }) });
  assert.ok(hasRule(missing, "description"), missing.join("\n"));
  const dup = check({ "research/index.html": page({ title: "Research", description: "Page A description", canonical: `${PREFIX}research/` }) });
  assert.ok(hasRule(dup, "description"), dup.join("\n"));
});

test("h1: two h1 elements are reported", () => {
  const p = check({ "research/index.html": page({ title: "Research", canonical: `${PREFIX}research/`, body: "<h1>Again</h1>" }) });
  assert.ok(hasRule(p, "h1"), p.join("\n"));
});

test("canonical: a mismatch with the sitemap loc is reported", () => {
  const p = check({ "research/index.html": page({ title: "Research", canonical: `${PREFIX}research/index.html` }) });
  assert.ok(hasRule(p, "canonical"), p.join("\n"));
});

test("noindex: a sitemap page with noindex is reported", () => {
  const p = check({ "research/index.html": page({ title: "Research", canonical: `${PREFIX}research/`, head: `<meta name="robots" content="noindex">` }) });
  assert.ok(hasRule(p, "noindex"), p.join("\n"));
});

test("orphan: a sitemap page no other page links to is reported", () => {
  const p = check({
    "lonely.html": page({ title: "Lonely", canonical: `${PREFIX}lonely.html` }),
    "sitemap.xml": sitemap([[PREFIX, "2026-10-20"], [`${PREFIX}a.html`, "2026-10-19"], [`${PREFIX}research/`, "2026-10-18"], [`${PREFIX}lonely.html`, "2026-10-18"]]),
  });
  assert.ok(p.some((x) => x.startsWith("lonely.html: orphan: ")), p.join("\n"));
});

test("jsonld: invalid structured data is reported", () => {
  const p = check({ "index.html": page({ title: "Home", canonical: PREFIX, head: `<script type="application/ld+json">{"@type":}</script>` }) });
  assert.ok(hasRule(p, "jsonld"), p.join("\n"));
});

test("llms: a broken site URL in llms.txt is reported", () => {
  const p = check({ "llms.txt": `- [Gone](${PREFIX}gone.html): nothing` });
  assert.ok(hasRule(p, "llms"), p.join("\n"));
});

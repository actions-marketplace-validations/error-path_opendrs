# Docs site long-term search visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the docs site to an Actions-built Jekyll 4.4 deploy with accurate `lastmod` dates
from git. IndexNow should report added, changed and removed pages from a sitemap diff. Fix the
structure and content gaps the spec lists, and enforce everything with a build-time site check.

**Architecture:** Three small, dependency-free Node ESM scripts in `scripts/`:
- `sitemap.mjs` parses a sitemap.
- `check-site.mjs` lints the built site.
- `indexnow-urls.mjs` diffs two sitemaps.

One workflow, `.github/workflows/pages.yml`, builds with Bundler and Jekyll 4.4, runs the
scripts, deploys with GitHub's Pages actions, then POSTs to IndexNow. The layout and content
changes are plain Jekyll: Liquid, Markdown and front matter.

**Tech Stack:** Jekyll 4.4 with jekyll-seo-tag, jekyll-sitemap, jekyll-relative-links and
jekyll-last-modified-at. Ruby 3.4. Node 22+ with `node:test`. GitHub Actions: checkout,
setup-ruby, setup-node, configure-pages, upload-pages-artifact and deploy-pages.

**Spec:** [docs/specs/2026-10-21-seo-long-term-design.md](../../specs/2026-10-21-seo-long-term-design.md)
(approved 2026-10-21).

## Global Constraints

- Site prefix: `https://error-path.github.io/opendrs/`. URLs never change, and `.html` URLs stay
  (spec §3, §4.3).
- No money spent and no new hosted services (spec §1).
- Keep the existing theme. Visual changes are limited to the eyebrow line, the "Updated" line,
  the footer links and the homepage H1 text (spec §4.3).
- IndexNow key `7761d20ca5295159e2dd2f14ffccbe2b`. The key file stays at
  `docs/7761d20ca5295159e2dd2f14ffccbe2b.txt` (spec §4.2).
- Scripts are plain Node ESM with **no dependencies**. Their tests run with `node --test`, never
  in the npm (vitest) suite (spec §4.4). vitest only includes `tests/**/*.test.ts`, so
  `scripts/*.test.mjs` is safe.
- Do not run `npm test`, `npm run check` or `build:action`. This is docs work.
- Never `git push`. Every commit ends with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Pin every action by commit SHA with a version comment:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
  - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`
  - `ruby/setup-ruby@824c0e29fdfc7d689c191c27acc969d2d04b7dd8 # v1.331.0`
  - `actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0`
  - `actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0`
  - `actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1`
- The About text is verbatim from spec §4.3.

## Review Focus

1. **A shallow checkout makes every `lastmod` equal and wrong.** jekyll-last-modified-at then
   reads one commit date for every file. Expected: the build fails loudly. Owner: Task 3, with a
   `git rev-parse --is-shallow-repository` guard step.
2. **The live sitemap can't be fetched** (network, first deploy, 404). Expected: treat the old
   sitemap as empty and submit every page, never fail the deploy. Owner: Task 1 (empty-old test)
   and Task 3 (`curl … || : > file`).
3. **`extra_urls` pasted with blank lines, CRLF, tabs or a foreign host.** Expected: whitespace is
   tolerated and a foreign URL fails the run with a clear message. Owner: Task 1 tests.
4. **Links the checker must not misjudge:** `#main` skip links, protocol-relative
   `//fonts.googleapis.com`, `mailto:`, directory links (`research/`), percent-encoded paths and
   `/opendrs` without a trailing slash. Expected: externals ignored, internals resolved like
   GitHub Pages does. Owner: Task 1 tests.
5. **Entities in sitemap `<loc>` (`&amp;`) and URLs in `llms.txt` followed by punctuation.**
   Expected: decoded and trimmed before comparing. Owner: Task 1 tests.

---

### Task 1: Site scripts (sitemap parser, site check, IndexNow URL list)

**Files:**
- Create: `scripts/sitemap.mjs`
- Create: `scripts/check-site.mjs`
- Create: `scripts/indexnow-urls.mjs`
- Test: `scripts/check-site.test.mjs`
- Test: `scripts/indexnow-urls.test.mjs`

**Interfaces:**
- Produces:
  - `parseSitemap(xml: string): {loc: string, lastmod: string}[]` and
    `decodeEntities(s: string): string` (sitemap.mjs)
  - `checkSite(siteDir: string, prefix?: string): string[]` (check-site.mjs). Each problem is
    formatted `"<file>: <rule>: <detail>"`.
  - `resolveInternal(href, fromFile, prefix): {path, fragment} | null` (check-site.mjs)
  - `indexNowUrls(oldXml: string, newXml: string, extra: string, prefix: string): string[]`
    (indexnow-urls.mjs). It throws `Error("extra URL outside <prefix>: <url>")`.
- CLIs:
  - `node scripts/check-site.mjs <site-dir> [prefix]` exits 1 on problems and prints one per line
    to stderr.
  - `node scripts/indexnow-urls.mjs <old-sitemap> <new-sitemap> <prefix>` reads `EXTRA_URLS` from
    the environment and prints one URL per line. A missing or empty old file means "no old
    sitemap".

- [ ] **Step 1: Write the failing tests**

`scripts/check-site.test.mjs`:

```js
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
```

`scripts/indexnow-urls.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/*.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./check-site.mjs` and `./indexnow-urls.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/sitemap.mjs`:

```js
// Sitemap parsing shared by check-site.mjs and indexnow-urls.mjs.

export function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseSitemap(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)]
    .map(([, block]) => ({
      loc: decodeEntities(block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/)?.[1] ?? ""),
      lastmod: block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/)?.[1] ?? "",
    }))
    .filter((entry) => entry.loc);
}
```

`scripts/check-site.mjs`:

```js
#!/usr/bin/env node
// Checks the built docs site against the rules in docs/specs/2026-10-21-seo-long-term-design.md §4.4:
// internal links, sitemap entries with lastmod, unique titles and descriptions, one h1, canonical
// URLs, no noindex, no orphan pages, valid JSON-LD and working llms.txt links.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeEntities, parseSitemap } from "./sitemap.mjs";

export const DEFAULT_PREFIX = "https://error-path.github.io/opendrs/";

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), base)
      : [relative(base, join(dir, entry.name)).split(sep).join("/")],
  );
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];

// Maps a link found in `fromFile` to the built file it points at, or null when it leaves the site.
export function resolveInternal(href, fromFile, prefix) {
  const base = new URL(prefix);
  let url;
  try {
    url = new URL(decodeEntities(href).trim(), new URL(fromFile, base));
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (url.pathname === base.pathname.slice(0, -1)) url.pathname = base.pathname;
  if (!url.pathname.startsWith(base.pathname)) return null;
  let path = decodeURIComponent(url.pathname.slice(base.pathname.length));
  if (path === "" || path.endsWith("/")) path += "index.html";
  return { path, fragment: url.hash ? decodeURIComponent(url.hash.slice(1)) : "" };
}

export function checkSite(siteDir, prefix = DEFAULT_PREFIX) {
  const problems = [];
  const report = (file, rule, detail) => problems.push(`${file}: ${rule}: ${detail}`);
  const files = new Set(walk(siteDir));
  const html = new Map(
    [...files].filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(join(siteDir, f), "utf8")]),
  );

  const ids = new Map();
  const idsOf = (file) => {
    if (!ids.has(file)) {
      ids.set(file, new Set([...(html.get(file) ?? "").matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => decodeEntities(m[1]))));
    }
    return ids.get(file);
  };

  const inbound = new Map();
  for (const [file, content] of html) {
    for (const [tag] of content.matchAll(/<(?:a|link|img|script|source)\b[^>]*>/gi)) {
      for (const name of ["href", "src"]) {
        const value = attr(tag, name);
        if (value === undefined) continue;
        const target = resolveInternal(value, file, prefix);
        if (!target) continue;
        if (!files.has(target.path)) {
          report(file, "link", `${value} -> missing ${target.path}`);
          continue;
        }
        if (target.fragment && target.path.endsWith(".html") && !idsOf(target.path).has(target.fragment)) {
          report(file, "link", `${value} -> no id "${target.fragment}" in ${target.path}`);
        }
        if (target.path !== file) {
          if (!inbound.has(target.path)) inbound.set(target.path, new Set());
          inbound.get(target.path).add(file);
        }
      }
    }
    for (const [, json] of content.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
      try {
        JSON.parse(json);
      } catch (error) {
        report(file, "jsonld", error.message);
      }
    }
  }

  if (!files.has("sitemap.xml")) {
    report("sitemap.xml", "sitemap", "missing");
    return problems;
  }
  const titles = new Map();
  const descriptions = new Map();
  for (const { loc, lastmod } of parseSitemap(readFileSync(join(siteDir, "sitemap.xml"), "utf8"))) {
    const target = resolveInternal(loc, "index.html", prefix);
    if (!target) {
      report("sitemap.xml", "sitemap", `${loc} is outside ${prefix}`);
      continue;
    }
    if (!files.has(target.path)) {
      report("sitemap.xml", "sitemap", `${loc} -> missing ${target.path}`);
      continue;
    }
    if (!lastmod) report("sitemap.xml", "sitemap", `${loc} has no lastmod`);
    if (/^(superpowers|specs)\//.test(target.path)) report("sitemap.xml", "sitemap", `${loc} is an internal page`);
    const file = target.path;
    const content = html.get(file);
    if (content === undefined) continue;

    const pageTitles = [...content.matchAll(/<title>([\s\S]*?)<\/title>/gi)].map((m) => decodeEntities(m[1]).trim());
    if (pageTitles.length !== 1) report(file, "title", `${pageTitles.length} <title> elements`);
    else titles.set(pageTitles[0], [...(titles.get(pageTitles[0]) ?? []), file]);

    const pageDescriptions = [...content.matchAll(/<meta name="description" content="([^"]*)"/gi)].map((m) =>
      decodeEntities(m[1]).trim(),
    );
    if (pageDescriptions.length !== 1 || !pageDescriptions[0]) report(file, "description", "missing, empty or repeated");
    else descriptions.set(pageDescriptions[0], [...(descriptions.get(pageDescriptions[0]) ?? []), file]);

    const h1s = (content.match(/<h1[\s>]/gi) ?? []).length;
    if (h1s !== 1) report(file, "h1", `${h1s} <h1> elements`);

    const canonical = content.match(/<link rel="canonical" href="([^"]*)"/i)?.[1];
    if (canonical === undefined || decodeEntities(canonical) !== loc) report(file, "canonical", `${canonical ?? "none"} != ${loc}`);

    if (/<meta name="robots" content="[^"]*noindex/i.test(content)) report(file, "noindex", "sitemap page has noindex");

    if (file !== "index.html" && !inbound.get(file)?.size) report(file, "orphan", "no other page links here");
  }
  for (const [title, where] of titles) if (where.length > 1) report(where.join(", "), "title", `duplicate "${title}"`);
  for (const [text, where] of descriptions) if (where.length > 1) report(where.join(", "), "description", `duplicate "${text}"`);

  if (files.has("llms.txt")) {
    for (const raw of readFileSync(join(siteDir, "llms.txt"), "utf8").match(/https?:\/\/[^\s)>\]]+/g) ?? []) {
      const url = raw.replace(/[.,;:]+$/, "");
      const target = resolveInternal(url, "llms.txt", prefix);
      if (target && !files.has(target.path)) report("llms.txt", "llms", `${url} -> missing ${target.path}`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [siteDir, prefix = DEFAULT_PREFIX] = process.argv.slice(2);
  if (!siteDir) {
    console.error("usage: node scripts/check-site.mjs <site-dir> [prefix]");
    process.exit(2);
  }
  const problems = checkSite(siteDir, prefix);
  for (const problem of problems) console.error(problem);
  console.log(problems.length ? `site check: ${problems.length} problem(s)` : "site check passed");
  process.exit(problems.length ? 1 : 0);
}
```

`scripts/indexnow-urls.mjs`:

```js
#!/usr/bin/env node
// Lists the URLs to send to IndexNow: pages added, changed (new lastmod) or removed between the
// live sitemap and the freshly built one, plus any extra URLs from a manual run.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSitemap } from "./sitemap.mjs";

export function indexNowUrls(oldXml, newXml, extra, prefix) {
  const before = new Map(parseSitemap(oldXml).map((e) => [e.loc, e.lastmod]));
  const after = new Map(parseSitemap(newXml).map((e) => [e.loc, e.lastmod]));
  const urls = new Set();
  for (const [loc, lastmod] of after) if (before.get(loc) !== lastmod) urls.add(loc);
  for (const loc of before.keys()) if (!after.has(loc)) urls.add(loc);
  for (const url of extra.split(/\s+/).filter(Boolean)) {
    if (!url.startsWith(prefix)) throw new Error(`extra URL outside ${prefix}: ${url}`);
    urls.add(url);
  }
  return [...urls];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [oldPath, newPath, prefix] = process.argv.slice(2);
  if (!newPath || !prefix) {
    console.error("usage: EXTRA_URLS='…' node scripts/indexnow-urls.mjs <old-sitemap> <new-sitemap> <prefix>");
    process.exit(2);
  }
  const oldXml = oldPath && existsSync(oldPath) ? readFileSync(oldPath, "utf8") : "";
  try {
    const urls = indexNowUrls(oldXml, readFileSync(newPath, "utf8"), process.env.EXTRA_URLS ?? "", prefix);
    if (urls.length) console.log(urls.join("\n"));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
```

Note: in `indexNowUrls`, `before.get(loc) !== lastmod` is `undefined !== "…"` for an added URL,
so one condition covers both added and changed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/*.test.mjs`
Expected: PASS, all tests in both files.

- [ ] **Step 5: Commit**

```bash
git add scripts/sitemap.mjs scripts/check-site.mjs scripts/indexnow-urls.mjs scripts/check-site.test.mjs scripts/indexnow-urls.test.mjs
git commit -m "feat(docs-site): site check and IndexNow URL list scripts" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 2: Build with Jekyll 4.4 and prove parity

**Files:**
- Create: `docs/Gemfile`, `docs/Gemfile.lock`, `docs/.ruby-version`
- Modify: `docs/_config.yml` (`plugins:`)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `node scripts/check-site.mjs <dir>` (Task 1)
- Produces: `cd docs && bundle exec jekyll build -d _site` builds the site with `<lastmod>` on
  every sitemap entry (used by Task 3's workflow and Task 4's verification)

- [ ] **Step 1: Install a Ruby that can run Jekyll 4.4.** System Ruby 2.6 cannot.

Run: `brew install ruby && /opt/homebrew/opt/ruby/bin/ruby -v`
Expected: `ruby 3.4.x` or newer. Use `export PATH=/opt/homebrew/opt/ruby/bin:$PATH` and keep
gems out of the repo with `export BUNDLE_PATH=<scratchpad>/bundle`.

- [ ] **Step 2: Write `docs/Gemfile`, `docs/.ruby-version` and the plugin list**

`docs/Gemfile`:

```ruby
source "https://rubygems.org"

gem "jekyll", "~> 4.4"

group :jekyll_plugins do
  gem "jekyll-seo-tag", "~> 2.9"
  gem "jekyll-sitemap", "~> 1.4"
  gem "jekyll-relative-links", "~> 0.9"
  gem "jekyll-last-modified-at", "~> 1.3"
end
```

`docs/.ruby-version`:

```
3.4
```

In `docs/_config.yml`, replace the `plugins:` block with:

```yaml
plugins:
  - jekyll-seo-tag
  - jekyll-sitemap
  - jekyll-relative-links
  - jekyll-last-modified-at
```

Append to `.gitignore`:

```
docs/_site/
docs/.jekyll-cache/
```

- [ ] **Step 3: Lock dependencies for macOS and the Linux runner**

Run: `cd docs && bundle lock --add-platform x86_64-linux && bundle install`
Expected: `docs/Gemfile.lock` is created and lists `x86_64-linux` under `PLATFORMS`.

- [ ] **Step 4: Build and check that the build excluded its own tooling files**

Run: `cd docs && bundle exec jekyll build -d _site && ls _site | grep -E 'Gemfile|ruby-version' ; grep -c '<lastmod>' _site/sitemap.xml`
Expected: the `ls | grep` prints nothing, and the `<lastmod>` count equals the number of
`<url>` entries (20).

- [ ] **Step 5: Parity diff against the live site.** Live is the legacy builder's output of
  `main`, which this branch matches apart from Task 1 and these build files.

Run (a scratch script, not committed):

```bash
S=<scratchpad>; rm -rf $S/live && mkdir -p $S/live
curl -fsS https://error-path.github.io/opendrs/sitemap.xml | grep -o '<loc>[^<]*' | sed 's/<loc>//' | while read -r u; do
  p=${u#https://error-path.github.io/opendrs/}; [ -z "$p" ] && p=index.html
  mkdir -p "$S/live/$(dirname "$p")"; curl -fsS "$u" -o "$S/live/$p"
done
python3 - "$S/live" docs/_site <<'EOF'
import sys, re, pathlib, difflib
live, new = map(pathlib.Path, sys.argv[1:])
def norm(t):
    t = re.sub(r'<meta name="generator"[^>]*>', '', t)
    t = re.sub(r'"date(Modified|Published)":"[^"]*",?', '', t)
    t = re.sub(r'<meta property="article:(modified|published)_time"[^>]*>', '', t)
    return [l.strip() for l in t.splitlines() if l.strip()]
bad = 0
for f in sorted(live.rglob('*.html')):
    rel = f.relative_to(live); g = new / rel
    d = list(difflib.unified_diff(norm(f.read_text()), norm(g.read_text()), str(rel), str(rel), lineterm='', n=0))
    if d: bad += 1; print('\n'.join(d[:40]))
print('pages with differences:', bad)
EOF
```

Expected: `pages with differences: 0`. If a difference comes from jekyll-seo-tag 2.8.0 → 2.9.x
(JSON-LD key order, a new og tag), list it in the commit message body. Any other difference, such
as Markdown rendering, anchor ids or curly quotes, must be fixed in `_config.yml` (for example
`kramdown:` options) until the diff is clean.

- [ ] **Step 6: Run the site check on this build.** This is spec §5.2, proving the check catches
  real problems on today's content.

Run: `node scripts/check-site.mjs docs/_site`
Expected: exit 1, with these orphan reports:
- `research/2026-10-20-code-review-at-anthropic.html: orphan: …`
- `maintaining.html: orphan: …`

There should be no `sitemap` lastmod reports. The check also validates `#fragment` links for the
first time, so it may report broken anchors that already exist. Each one is a real defect: fix it
in Task 4 by correcting the link to the heading's actual id, and list it in the report. Save the
output for the final report.

- [ ] **Step 7: Commit**

```bash
git add docs/Gemfile docs/Gemfile.lock docs/.ruby-version docs/_config.yml .gitignore
git commit -m "build(docs-site): Jekyll 4.4 with explicit plugins and git-based lastmod" -m "<parity notes from step 5>" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 3: Pages workflow (build, check, deploy, IndexNow)

**Files:**
- Create: `.github/workflows/pages.yml`
- Delete: `.github/workflows/indexnow.yml`
- Modify: `.github/dependabot.yml`

**Interfaces:**
- Consumes: the Task 1 CLIs and the Task 2 Gemfile
- Produces: workflow `pages` with jobs `build`, `deploy` and `indexnow`, and a `workflow_dispatch`
  input `extra_urls`

- [ ] **Step 1: Write `.github/workflows/pages.yml`**

```yaml
name: pages

# Builds docs/ with Jekyll, checks the result (scripts/check-site.mjs), deploys it to GitHub Pages
# and tells IndexNow which pages were added, changed or removed. Pull requests only build and check.
on:
  push:
    branches: [main]
    paths:
      - "docs/**"
      - "scripts/sitemap.mjs"
      - "scripts/check-site*.mjs"
      - "scripts/indexnow-urls*.mjs"
      - ".github/workflows/pages.yml"
  pull_request:
    paths:
      - "docs/**"
      - "scripts/sitemap.mjs"
      - "scripts/check-site*.mjs"
      - "scripts/indexnow-urls*.mjs"
      - ".github/workflows/pages.yml"
  workflow_dispatch:
    inputs:
      extra_urls:
        description: "Extra URLs to send to IndexNow (one per line), such as removed pages"
        required: false
        default: ""

permissions:
  contents: read

concurrency:
  group: ${{ github.event_name == 'pull_request' && format('pages-pr-{0}', github.event.pull_request.number) || 'pages' }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  SITE: https://error-path.github.io/opendrs/

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      urls: ${{ steps.urls.outputs.urls }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # lastmod comes from each page's last commit
      - name: Refuse a shallow clone
        run: test "$(git rev-parse --is-shallow-repository)" = false
      - uses: ruby/setup-ruby@824c0e29fdfc7d689c191c27acc969d2d04b7dd8 # v1.331.0
        with:
          working-directory: docs
          bundler-cache: true
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - name: Test the site scripts
        run: node --test scripts/*.test.mjs
      - if: github.event_name != 'pull_request'
        uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0
      - name: Build
        working-directory: docs
        env:
          JEKYLL_ENV: production
        run: bundle exec jekyll build --destination _site
      - name: Check the site
        run: node scripts/check-site.mjs docs/_site "$SITE"
      - name: List pages for IndexNow
        id: urls
        if: github.event_name != 'pull_request'
        env:
          EXTRA_URLS: ${{ inputs.extra_urls }}
        run: |
          curl -fsS "${SITE}sitemap.xml?$GITHUB_RUN_ID" -o live-sitemap.xml || : > live-sitemap.xml
          node scripts/indexnow-urls.mjs live-sitemap.xml docs/_site/sitemap.xml "$SITE" > urls.txt
          if [ -s urls.txt ]; then cat urls.txt; else echo "No published pages changed."; fi
          { echo 'urls<<URLS_EOF'; cat urls.txt; echo 'URLS_EOF'; } >> "$GITHUB_OUTPUT"
      - if: github.event_name != 'pull_request'
        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: docs/_site

  deploy:
    if: github.event_name != 'pull_request'
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1

  indexnow:
    if: github.event_name != 'pull_request' && needs.build.outputs.urls != ''
    needs: [build, deploy]
    runs-on: ubuntu-latest
    env:
      KEY: 7761d20ca5295159e2dd2f14ffccbe2b
      URLS: ${{ needs.build.outputs.urls }}
    steps:
      - name: Submit to IndexNow
        run: |
          printf '%s\n' "$URLS" \
            | jq -Rn --arg key "$KEY" --arg site "$SITE" \
                '{host: "error-path.github.io", key: $key, keyLocation: ($site + $key + ".txt"), urlList: [inputs | select(length > 0)]}' \
            | curl -fsS -X POST https://api.indexnow.org/indexnow \
                -H 'Content-Type: application/json; charset=utf-8' --data-binary @- -w 'IndexNow HTTP %{http_code}\n'
```

- [ ] **Step 2: Delete the old workflow and add Dependabot for the docs gems**

Run: `git rm .github/workflows/indexnow.yml`

Append to `.github/dependabot.yml`:

```yaml
  - package-ecosystem: bundler
    directory: /docs
    schedule: { interval: weekly }
```

- [ ] **Step 3: Validate the workflow statically**

Run:
```bash
ruby -ryaml -e 'w = YAML.load_file(".github/workflows/pages.yml"); p w["jobs"].keys; w["jobs"].each { |n, j| (j["steps"] || []).each { |s| puts s["run"] if s["run"] } }' > /dev/null
for j in build indexnow; do ruby -ryaml -e "YAML.load_file('.github/workflows/pages.yml')['jobs']['$j']['steps'].each { |s| puts s['run'] if s['run'] }" | bash -n && echo "$j ok"; done
ruby -ryaml -e 'YAML.load_file(".github/dependabot.yml")' && echo dependabot ok
```
Expected: `build ok`, `indexnow ok` and `dependabot ok` with no YAML errors. Then check by eye that
the deploy job, the indexnow job and the IndexNow/upload/configure steps all carry
`github.event_name != 'pull_request'`.

- [ ] **Step 4: Dry-run the URL list against the live sitemap.** Nothing is sent.

Run: `curl -fsS https://error-path.github.io/opendrs/sitemap.xml -o <scratchpad>/live.xml && EXTRA_URLS="" node scripts/indexnow-urls.mjs <scratchpad>/live.xml docs/_site/sitemap.xml https://error-path.github.io/opendrs/`
Expected: all 20 live URLs, because the live sitemap has no lastmod yet. Then pipe the list
through the same `jq` filter from the workflow and confirm the JSON has `host`, `key`,
`keyLocation` and 20 `urlList` entries.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/pages.yml .github/dependabot.yml
git commit -m "ci(docs-site): Actions-built Pages deploy with site check and IndexNow from sitemap diff" -m "Replaces indexnow.yml (page_build only fires for the legacy builder). Removed pages are now reported too." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 4: Structure and content

**Files:**
- Modify: `docs/_layouts/default.html` (eyebrow, Updated line, footer)
- Modify: `docs/assets/site.css:97-98` (`.edit` colour, new `.eyebrow`)
- Modify: `docs/_config.yml` (`nav.more` gets Research)
- Modify: `docs/index.html:24` (H1)
- Modify: the three research notes (front matter `date:` and opening summary)
- Modify: `docs/llms.txt`
- Create: `docs/research/index.md`, `docs/about.md`, `docs/404.html`

**Interfaces:**
- Consumes: `page.last_modified_at` (jekyll-last-modified-at, Task 2) and the check script
  (Task 1)
- Produces: a site on which `node scripts/check-site.mjs docs/_site` exits 0

- [ ] **Step 1: Layout.** In `docs/_layouts/default.html`, replace the article block:

```html
      <article class="prose">
        {{ content }}
        <p class="edit"><a href="https://github.com/error-path/opendrs/blob/main/docs/{{ page.path }}">Edit this page on GitHub</a></p>
      </article>
```

with:

```html
      <article class="prose">
        {% if page.date %}<p class="eyebrow">Research note · By {{ site.author.name }} · Published {{ page.date | date: "%-d %b %Y" }}</p>{% endif %}
        {{ content }}
        <p class="edit">{% if page.last_modified_at %}Updated {{ page.last_modified_at | date: "%-d %b %Y" }} · {% endif %}<a href="https://github.com/error-path/opendrs/blob/main/docs/{{ page.path }}">Edit this page on GitHub</a></p>
      </article>
```

In the footer, replace

```html
      <p><a href="https://github.com/error-path/opendrs">Source</a> <a href="https://github.com/error-path/opendrs/releases">Releases</a> <a href="https://github.com/marketplace/actions/opendrs-diff-risk-score">GitHub Marketplace</a> <a href="https://github.com/error-path/opendrs/issues">Issues</a> <a href="{{ '/llms.txt' | relative_url }}">llms.txt</a></p>
```

with

```html
      <p><a href="https://github.com/error-path/opendrs">Source</a> <a href="https://github.com/error-path/opendrs/releases">Releases</a> <a href="https://github.com/marketplace/actions/opendrs-diff-risk-score">GitHub Marketplace</a> <a href="https://github.com/error-path/opendrs/issues">Issues</a> <a href="{{ '/research/' | relative_url }}">Research</a> <a href="{{ '/about.html' | relative_url }}">About</a> <a href="{{ '/maintaining.html' | relative_url }}">Maintaining</a> <a href="{{ '/llms.txt' | relative_url }}">llms.txt</a></p>
```

In `docs/assets/site.css`, line 97 is `.edit { margin-top: 3.5rem; font-size: 0.875rem; }` and
line 98 is `.edit a { color: var(--muted); }`. The new "Updated …" text sits in `.edit`, so give
the whole line the muted colour. Replace line 97 with:

```css
.edit { margin-top: 3.5rem; font-size: 0.875rem; color: var(--muted); }
```

and add after line 98:

```css
.eyebrow { margin: 0 0 0.75rem; font-size: 0.875rem; color: var(--muted); }
```

- [ ] **Step 2: Nav.** In `docs/_config.yml`, under `nav.more`, add this as the first entry:

```yaml
    - title: Research
      url: /research/
```

- [ ] **Step 3: Homepage H1.** In `docs/index.html`, replace
  `<h1>A 0–1 risk score for every pull request</h1>` with
  `<h1>opendrs: a 0–1 risk score for every pull request</h1>`.

- [ ] **Step 4: New pages**

`docs/research/index.md`:

```markdown
---
title: "Research notes"
description: "Dated research notes behind opendrs: field tests on real repositories, how AI code reviewers judge pull request risk, and what published code-review practice means for the tool."
---

# Research notes

Dated notes from building opendrs: what was tested, on which repositories, and what changed as a
result. Each note lists its sources. The [experiment log]({{ '/experiments.html' | relative_url }})
has the benchmark runs behind them.

{% assign notes = site.pages | where_exp: "p", "p.dir == '/research/'" | where_exp: "p", "p.date" | where_exp: "p", "p.sitemap != false" | sort: "date" | reverse %}
{% for note in notes %}
- [{{ note.title }}]({{ note.url | relative_url }}), {{ note.date | date: "%-d %b %Y" }}: {{ note.description }}
{% endfor %}
```

`docs/about.md`:

```markdown
---
title: "About these docs"
description: "Who maintains opendrs, how its code, docs and research notes are written and reviewed, and how to reproduce every benchmark number on this site."
---

# About these docs

opendrs is maintained by error-path and released under the MIT license. The code, these docs and
the research notes are written with AI assistance (Claude) and reviewed by the maintainer before
they are merged. Every benchmark number on this site comes from a script in the repository, and
[Results](results.md) shows how to reproduce each one. Corrections are welcome as
[GitHub issues](https://github.com/error-path/opendrs/issues).
```

`docs/404.html`:

```html
---
title: "Page not found"
permalink: /404.html
sitemap: false
---

<h1>Page not found</h1>
<p>This page doesn't exist or has moved.</p>
<ul>
  <li><a href="{{ '/' | relative_url }}">opendrs home</a></li>
  <li><a href="{{ '/auto-approve.html' | relative_url }}">Auto-approve PRs</a></li>
  <li><a href="{{ '/github-action.html' | relative_url }}">GitHub Action</a></li>
  <li><a href="{{ '/cli-and-mcp.html' | relative_url }}">CLI &amp; MCP</a></li>
</ul>
```

- [ ] **Step 5: Research notes.** Body text is otherwise unchanged.

`docs/research/2026-10-18-review-risk-heuristics.md`: add `date: 2026-10-18` to the front matter,
and replace the line pair

```
Research note, 2026-10-18. Sources were read on that date. Anything taken from a page summary
rather than the file itself is marked *(relayed)*.
```

with

```
Calibrated opendrs ties the Kamei JIT-metrics baseline on ApacheJIT (AUC 0.819 against 0.821),
and the optional LLM judge adds only about 0.02 AUC because it flags about half of all commits as
risky. This note reviews how Superpowers, Anthropic's `/code-review` and security-review plugins,
PR-Agent and other AI reviewers decide a change is risky, consolidates their heuristics, and ranks
ten changes opendrs could make, with a pre-registered plan for the next judge experiment.

Sources were read on 2026-10-18. Anything taken from a page summary rather than the file itself is
marked *(relayed)*.
```

`docs/research/2026-10-19-field-test.md`: add `date: 2026-10-19` to the front matter, and replace

```
Research note, 2026-10-19. Based on six field-test session notes in
`~/.cache/opendrs/field-test/notes/` (`black.md`, `cli-cli.md`, `actix-web.md`, `vite.md`,
`fastlane.md`, `vapor.md`), plus raw `brief`/`score` JSON for a subset of PRs under `notes/raw/`.
This note summarizes those six sessions; it does not re-run opendrs.
```

with

```
opendrs 0.4.0 was run on about eight merged pull requests in each of six repositories, written in
Python, Go, Rust, TypeScript, Ruby and Swift. On mature, active repositories most non-trivial PRs
scored red regardless of size. Language gaps silently disabled signals: Go import resolution
picked the wrong module, Ruby's public-declaration detector was a stub, and Swift had no import
extractor. The note ends with a ranked list of fixes.

It summarizes six field-test sessions, one per repository, and the raw `brief` and `score` JSON
saved for a subset of PRs. It does not re-run opendrs.
```

`docs/research/2026-10-20-code-review-at-anthropic.md`: add `date: 2026-10-20` to the front
matter, and replace `Research note, 2026-10-20, re-checked against the source the same day.
Source:` (the start of the first paragraph, which wraps onto the next line) with

```
Anthropic's write-up on how the Claude Code team reviews code describes six layers of checks, and
its largest stated gain comes from agents verifying their own work before a pull request exists.
This note maps each practice to what opendrs already does: risk-tiered approval, blocked paths and
the merge queue are in place, and verified, severity-tagged findings are not. It then weighs three
approaches to close the gap.

Re-checked against the source on 2026-10-20. Source:
```

keeping the rest of that paragraph as it is.

- [ ] **Step 6: llms.txt.** In `docs/llms.txt`, under `## Docs`, after the "PR risk tools
  compared" line, add:

```
- [Research notes](https://error-path.github.io/opendrs/research/): dated field tests and research behind opendrs's design decisions
- [About these docs](https://error-path.github.io/opendrs/about.html): who maintains opendrs and how the docs and research are written and reviewed
```

- [ ] **Step 7: Build and check**

Run: `cd docs && bundle exec jekyll build -d _site && cd .. && node scripts/check-site.mjs docs/_site`
Expected: `site check passed` (exit 0). Then spot-check:
- `grep -c '<lastmod>' docs/_site/sitemap.xml` shows 22: 20 plus research index and about.
- `docs/_site/404.html` is not in the sitemap.
- `docs/_site/research/index.html` lists the three notes newest first.
- The field-test page shows "Research note · By error-path · Published 19 Oct 2026".
- `captain.html` ends with "Updated … · Edit this page on GitHub".
- The JSON-LD on the field-test page has `"@type":"BlogPosting"` and `datePublished`.

- [ ] **Step 8: Commit**

```bash
git add docs/_layouts/default.html docs/assets/site.css docs/_config.yml docs/index.html docs/research docs/about.md docs/404.html docs/llms.txt
git commit -m "docs(site): research hub, About page, bylines and dates, 404 page, homepage H1" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 5: Runbook and spec sync

**Files:**
- Modify: `docs/maintaining.md` (new "Docs site" section)
- Modify: `docs/specs/2026-10-21-seo-long-term-design.md` (script names and empty-list behaviour)

- [ ] **Step 1: Add to `docs/maintaining.md`, before "## Handling a security report":**

```markdown
## Docs site

The site in `docs/` is built and deployed by the `pages` workflow, using Jekyll 4.4 (see
`docs/Gemfile`). It needs no secrets. Every run:

1. builds the site and runs `scripts/check-site.mjs`, which fails on a broken internal link, a
   missing or duplicate title or description, more than one `<h1>`, a page no other page links
   to, a sitemap entry without `lastmod`, invalid JSON-LD or a broken `llms.txt` link. Pull
   requests that touch `docs/` run the same build and check, without deploying;
2. deploys to GitHub Pages;
3. sends IndexNow the pages that were added, changed (new `lastmod`) or removed, by comparing the
   live sitemap with the new one.

To tell Bing about URLs by hand, such as pages removed outside a deploy, run the workflow from the
Actions tab and paste them into `extra_urls`, one per line. The IndexNow key is the file
`docs/7761d20ca5295159e2dd2f14ffccbe2b.txt` and `KEY` in `.github/workflows/pages.yml`. To rotate
it, replace both. To preview locally: `cd docs && bundle install && bundle exec jekyll serve`.
```

- [ ] **Step 2: Sync the spec with what was built.** In
  `docs/specs/2026-10-21-seo-long-term-design.md`:
  - **§4.2 "Submit" bullet:** replace "An empty list logs "No published pages changed." and exits
    0." with "An empty list is logged as "No published pages changed." in the build job, and the
    `indexnow` job is skipped."
  - **§4.1 build step 6:** after "compute the IndexNow URL list (4.2)", add "with
    `scripts/indexnow-urls.mjs`".
  - **§4.4 first paragraph:** add "Sitemap parsing is shared with `indexnow-urls.mjs` through
    `scripts/sitemap.mjs`." Also replace the test file name `scripts/check-site.test.mjs` with
    "`scripts/check-site.test.mjs` and `scripts/indexnow-urls.test.mjs`".

- [ ] **Step 3: Build and check again**, because `maintaining.md` changed.

Run: `cd docs && bundle exec jekyll build -d _site && cd .. && node scripts/check-site.mjs docs/_site`
Expected: `site check passed`.

- [ ] **Step 4: Commit**

```bash
git add docs/maintaining.md docs/specs/2026-10-21-seo-long-term-design.md
git commit -m "docs: runbook for the docs site workflow; sync spec with the built scripts" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Task 6: Final verification

- [ ] **Step 1:** Run `node --test scripts/*.test.mjs`. Expected: all pass.
- [ ] **Step 2:** Run a clean build plus the check:
  `rm -rf docs/_site docs/.jekyll-cache && (cd docs && bundle exec jekyll build -d _site) && node scripts/check-site.mjs docs/_site`.
  Expected: `site check passed`.
- [ ] **Step 3:** Run the Task 2 step 5 parity diff again. Expected: differences only on the
  pages Task 4 changed on purpose, which are the layout's Updated line on every page, the footer,
  the homepage H1 and the research notes. List them in the report.
- [ ] **Step 4:** Repeat the Task 3 step 3 static validation and the step 4 dry run. Expected: 22
  URLs.
- [ ] **Step 5:** `git status --short` is clean, with no `_site` or cache folders tracked, and
  `git log --oneline origin/main..HEAD` shows the spec, plan and five task commits.
- [ ] **Step 6:** Rename nothing. The branch is already `docs/seo-long-term`. Report the push
  command and the rollout steps from spec §6.

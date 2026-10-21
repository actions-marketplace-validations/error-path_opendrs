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

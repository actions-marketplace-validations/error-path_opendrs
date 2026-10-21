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
  for (const url of extra.split(/[\s,]+/).filter(Boolean)) {
    if (!url.startsWith(prefix)) throw new Error(`extra URL outside ${prefix}: ${url}`);
    // A multi-line paste into the single-line Run workflow field loses its newlines.
    if (url.includes("://", url.indexOf("://") + 3)) throw new Error(`extra URLs run together, separate them with spaces: ${url}`);
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

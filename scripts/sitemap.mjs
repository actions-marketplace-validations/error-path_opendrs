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

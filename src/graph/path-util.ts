import { posix } from "node:path";

/** Parent directory of a repo-relative path; "" for the repo root. */
export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Join and normalize; undefined when the result escapes the repo root. */
export function joinPath(dir: string, rel: string): string | undefined {
  const p = posix.normalize(dir ? `${dir}/${rel}` : rel).replace(/\/$/, "");
  return p === ".." || p.startsWith("../") || p.startsWith("/") ? undefined : p === "." ? "" : p;
}

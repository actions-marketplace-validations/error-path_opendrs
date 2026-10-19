/** Spec §6.2: the first `depth` path segments of `path`'s directory ("" for a file at the root). */
export function moduleOf(path: string, depth: number): string {
  const parts = path.split("/");
  parts.pop(); // drop the file name
  return parts.slice(0, depth).join("/");
}

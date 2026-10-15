import type { DependencyGraph } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";

/** Build the reverse import graph of the tree at `ref` (cached by tree sha under .opendrs/cache). */
export async function buildDependencyGraph(_repoDir: string, _ref: string, _config: OpendrsConfig): Promise<DependencyGraph> {
  throw new Error("not implemented: workstream B");
}

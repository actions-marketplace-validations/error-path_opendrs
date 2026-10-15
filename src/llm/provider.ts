import type { LlmProvider } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";

/** Returns undefined when llm.enabled is false. Throws OpendrsError("llm") when enabled but no API key. */
export function createLlmProvider(_config: OpendrsConfig, _env: NodeJS.ProcessEnv = process.env): LlmProvider | undefined {
  throw new Error("not implemented: workstream D");
}

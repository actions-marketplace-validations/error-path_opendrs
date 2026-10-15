import { OpendrsError, type LlmProvider } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAiProvider } from "./openai.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocal(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** Returns undefined when llm.enabled is false. Throws OpendrsError("llm") when enabled but no API key. */
export function createLlmProvider(config: OpendrsConfig, env: NodeJS.ProcessEnv = process.env): LlmProvider | undefined {
  const { enabled, provider, model, baseUrl, apiKeyEnv } = config.llm;
  if (!enabled) return undefined;

  const keyEnv = apiKeyEnv ?? (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
  const apiKey = env[keyEnv] || undefined;
  const keyOptional = provider === "openai" && isLocal(baseUrl);
  if (!apiKey && !keyOptional) {
    throw new OpendrsError(
      `The LLM judge is enabled (llm.enabled: true, provider ${provider}) but ${keyEnv} is not set. ` +
        `Export ${keyEnv}, point llm.apiKeyEnv at the variable that holds the key, or set llm.enabled: false in .opendrs.yml.`,
      "llm",
    );
  }

  if (provider === "anthropic") return createAnthropicProvider({ model, apiKey: apiKey!, baseUrl });

  // llm.model defaults to a Claude id; api.openai.com would reject it with an opaque 404.
  if (!baseUrl && model.startsWith("claude-")) {
    throw new OpendrsError(
      `llm.provider is openai but llm.model is "${model}". Set llm.model to an OpenAI model, or set llm.baseUrl to a gateway that serves it.`,
      "llm",
    );
  }
  return createOpenAiProvider({ model, apiKey, baseUrl });
}

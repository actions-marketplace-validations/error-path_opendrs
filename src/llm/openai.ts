import { OpendrsError, type LlmProvider } from "../domain/types.js";
import { postJson } from "./http.js";
import { parseJudgement } from "./parse.js";
import { buildMessages } from "./prompt.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/** OpenAI-compatible chat/completions: OpenAI, Azure-compatible gateways, Ollama, vLLM. */
export function createOpenAiProvider(opts: { model: string; apiKey?: string; baseUrl?: string }): LlmProvider {
  const url = `${(opts.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const auth: Record<string, string> = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};

  return {
    name: "openai",
    async judge(input) {
      const { system, user } = buildMessages(input);
      const res = (await postJson(
        "OpenAI-compatible API",
        url,
        auth,
        {
          model: opts.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        opts.apiKey,
      )) as ChatCompletion;

      const content = res.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new OpendrsError("OpenAI-compatible API returned no message content", "llm");
      return parseJudgement(content, input.files);
    },
  };
}

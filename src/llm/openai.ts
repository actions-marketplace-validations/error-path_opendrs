import { OpendrsError, type LlmProvider } from "../domain/types.js";
import { postJson } from "./http.js";
import { parseJudgement } from "./parse.js";
import { buildMessages } from "./prompt.js";
import { JUDGEMENT_SCHEMA } from "./schema.js";
import { VERIFY_SCHEMA, buildVerifyMessages, parseVerification } from "./verify.js";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI-compatible chat/completions: OpenAI, Azure-compatible gateways, Ollama, vLLM. */
export function createOpenAiProvider(opts: { model: string; apiKey?: string; baseUrl?: string }): LlmProvider {
  const url = `${(opts.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const auth: Record<string, string> = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};

  const post = (system: string, user: string, name: string, schema: unknown) =>
    postJson(
      "OpenAI-compatible API",
      url,
      auth,
      {
        model: opts.model,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name, schema, strict: true } },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      opts.apiKey,
    ) as Promise<ChatCompletion>;

  const contentOf = (res: ChatCompletion) => {
    const content = res.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new OpendrsError("OpenAI-compatible API returned no message content", "llm");
    return content;
  };

  return {
    name: "openai",
    async judge(input) {
      const { system, user } = buildMessages(input);
      const res = await post(system, user, "judgement", JUDGEMENT_SCHEMA);
      return parseJudgement(contentOf(res), input.files, input.hunks, input.truncated);
    },
    async verify(input) {
      const { system, user } = buildVerifyMessages(input);
      const res = await post(system, user, "verification", VERIFY_SCHEMA);
      const files = [...new Set(input.candidates.map((c) => c.file))];
      return {
        verdicts: parseVerification(contentOf(res), input.candidates, files),
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      };
    },
  };
}

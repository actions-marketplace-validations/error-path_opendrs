import { OpendrsError, type LlmProvider } from "../domain/types.js";
import { postJson } from "./http.js";
import { parseJudgement } from "./parse.js";
import { buildMessages } from "./prompt.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 16_000;

// Models up to Opus 4.6 / Sonnet 4.6 / Haiku 4.5 accept `temperature`. Opus 4.7+, Sonnet 5 and later
// reject non-default sampling parameters with a 400, so those get a low effort setting instead.
const ACCEPTS_TEMPERATURE = /claude-(?:3[\w.-]*|(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:[-@]\d{8})?)$/;

interface MessagesResponse {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
}

export function createAnthropicProvider(opts: { model: string; apiKey: string; baseUrl?: string }): LlmProvider {
  const url = `${(opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/messages`;
  const sampling = ACCEPTS_TEMPERATURE.test(opts.model) ? { temperature: 0 } : { output_config: { effort: "low" } };

  return {
    name: "anthropic",
    async judge(input) {
      const { system, user } = buildMessages(input);
      const res = (await postJson(
        "Anthropic API",
        url,
        { "x-api-key": opts.apiKey, "anthropic-version": API_VERSION },
        { model: opts.model, max_tokens: MAX_TOKENS, ...sampling, system, messages: [{ role: "user", content: user }] },
        opts.apiKey,
      )) as MessagesResponse;

      if (res.stop_reason === "refusal") throw new OpendrsError("Anthropic API refused to judge this diff", "llm");
      const text = (res.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      return parseJudgement(text, input.files);
    },
  };
}

import { LLM_RISK_CATEGORIES, LLM_SAFE_CATEGORIES, OpendrsError, type LlmProvider } from "../domain/types.js";
import { postJson } from "./http.js";
import { parseJudgement } from "./parse.js";
import { buildMessages } from "./prompt.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 16_000;

// Models up to Opus 4.6 / Sonnet 4.6 / Haiku 4.5 accept `temperature`. Opus 4.7+, Sonnet 5 and later
// reject non-default sampling parameters with a 400, so those get a low effort setting instead.
const ACCEPTS_TEMPERATURE = /claude-(?:3[\w.-]*|(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:[-@]\d{8})?)$/;
// Structured outputs (`output_config.format`) exist from Opus 4.1 / Haiku 4.5 / Sonnet 4.5 on; Claude 3.x and
// the 4.0 models reject the parameter, so they rely on the prompt alone.
const LACKS_STRUCTURED_OUTPUTS = /claude-(?:3[\w.-]*|(?:opus|sonnet|haiku)-4(?:-0)?(?:[-@]\d{8})?)$/;

/**
 * The judge's reply shape for structured outputs. No numeric bounds: the API rejects them, and
 * `parseJudgement` clamps anyway. Every object closes `additionalProperties`, as the API requires.
 */
export const JUDGEMENT_SCHEMA = {
  type: "object",
  properties: {
    risk: { type: "number" },
    confidence: { type: "number" },
    rationale: { type: "string" },
    hunks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hunk: { type: "integer" },
          category: { type: "string", enum: [...LLM_SAFE_CATEGORIES, ...LLM_RISK_CATEGORIES] },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["hunk", "category", "confidence", "reason"],
        additionalProperties: false,
      },
    },
    risky_snippets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          reason: { type: "string" },
        },
        required: ["file", "line", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["risk", "confidence", "rationale", "hunks", "risky_snippets"],
  additionalProperties: false,
} as const;

interface MessagesResponse {
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
}

export function createAnthropicProvider(opts: { model: string; apiKey: string; baseUrl?: string }): LlmProvider {
  const url = `${(opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/messages`;
  const outputConfig = {
    ...(ACCEPTS_TEMPERATURE.test(opts.model) ? {} : { effort: "low" }),
    ...(LACKS_STRUCTURED_OUTPUTS.test(opts.model) ? {} : { format: { type: "json_schema", schema: JUDGEMENT_SCHEMA } }),
  };
  const sampling = {
    ...(ACCEPTS_TEMPERATURE.test(opts.model) ? { temperature: 0 } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };

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
      return parseJudgement(text, input.files, input.hunks, input.truncated);
    },
  };
}

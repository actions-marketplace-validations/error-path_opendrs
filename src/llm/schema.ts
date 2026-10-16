import { LLM_RISK_CATEGORIES, LLM_SAFE_CATEGORIES } from "../domain/types.js";

/**
 * The judge's reply shape for structured outputs (Anthropic `output_config.format`, OpenAI
 * `response_format.json_schema`). No numeric bounds: the Anthropic API rejects them, and
 * `parseJudgement` clamps anyway. Every object closes `additionalProperties` and requires every
 * property, as both APIs' strict modes demand.
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

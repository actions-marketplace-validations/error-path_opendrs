import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLM_RISK_CATEGORIES, LLM_SAFE_CATEGORIES, OpendrsError } from "../../src/domain/types.js";
import { createAnthropicProvider, JUDGEMENT_SCHEMA } from "../../src/llm/anthropic.js";

const KEY = "sk-ant-test-SECRET-123";
const input = { title: "Add cache", diff: "diff --git a/src/a.ts b/src/a.ts\n[hunk 1]\n+x", files: ["src/a.ts"], hunks: [{ id: 1, file: "src/a.ts", line: 1 }], truncated: true };
const reply = {
  risk: 0.35,
  confidence: 7,
  rationale: "changes cache invalidation",
  hunks: [{ hunk: 1, category: "performance", confidence: 6, reason: "cache" }],
  risky_snippets: [{ file: "src/a.ts", line: 1, reason: "r" }],
};

function messageResponse(text: string, stop_reason = "end_turn"): Response {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    stop_reason,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text },
    ],
  });
}

const errorResponse = (status: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ type: "error", error: { type: "api_error", message } }, { status, headers });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const sentBody = (call = 0) => JSON.parse(fetchMock.mock.calls[call]![1].body as string) as Record<string, unknown>;

describe("anthropic provider", () => {
  it("posts a Messages API request and parses the text block", async () => {
    fetchMock.mockResolvedValue(messageResponse(JSON.stringify(reply)));
    const provider = createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY });

    const j = await provider.judge(input);

    expect(j).toEqual({
      risk: 0.35,
      rationale: "changes cache invalidation",
      riskySnippets: [{ file: "src/a.ts", line: 1, reason: "r" }],
      confidence: 7,
      hunks: [{ file: "src/a.ts", line: 1, category: "performance", safe: false, confidence: 6, reason: "cache" }],
      unclassified: [],
      truncated: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = sentBody();
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(typeof body.system).toBe("string");
    expect(body.messages).toEqual([{ role: "user", content: expect.stringContaining("<untrusted_diff>") }]);
    expect((body.messages as Array<{ content: string }>)[0]!.content).toContain("Hunks to classify: 1");
  });

  it("omits temperature on models that reject sampling parameters", async () => {
    fetchMock.mockResolvedValue(messageResponse(JSON.stringify(reply)));
    await createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input);
    expect(sentBody()).not.toHaveProperty("temperature");
  });

  it.each(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-5-20251101", "claude-sonnet-4-20250514"])(
    "sends temperature 0 to %s, which accepts it",
    async (model) => {
      fetchMock.mockResolvedValue(messageResponse(JSON.stringify(reply)));
      await createAnthropicProvider({ model, apiKey: KEY }).judge(input);
      expect(sentBody().temperature).toBe(0);
    },
  );

  it("asks for structured output matching the judge schema on models that support it", async () => {
    fetchMock.mockResolvedValue(messageResponse(JSON.stringify(reply)));
    await createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input);
    expect(sentBody().output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: JUDGEMENT_SCHEMA } });
  });

  it("keeps temperature 0 alongside the schema on Sonnet 4.5", async () => {
    fetchMock.mockResolvedValue(messageResponse(JSON.stringify(reply)));
    await createAnthropicProvider({ model: "claude-sonnet-4-5", apiKey: KEY }).judge(input);
    const body = sentBody();
    expect(body.temperature).toBe(0);
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: JUDGEMENT_SCHEMA } });
  });

  it.each(["claude-3-5-sonnet-20241022", "claude-sonnet-4-20250514", "claude-opus-4"])("sends no output_config to %s", async (model) => {
    fetchMock.mockResolvedValue(messageResponse(JSON.stringify(reply)));
    await createAnthropicProvider({ model, apiKey: KEY }).judge(input);
    expect(sentBody()).not.toHaveProperty("output_config");
  });

  it("schema enumerates exactly the judge categories and closes every object", () => {
    const { category } = JUDGEMENT_SCHEMA.properties.hunks.items.properties;
    expect(category.enum).toEqual([...LLM_SAFE_CATEGORIES, ...LLM_RISK_CATEGORIES]);
    expect(category.enum).toHaveLength(14);
    expect(JUDGEMENT_SCHEMA.required).toEqual(["risk", "confidence", "rationale", "hunks", "risky_snippets"]);
    const objects: Array<Record<string, unknown>> = [];
    const walk = (node: unknown) => {
      if (typeof node !== "object" || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") objects.push(n);
      Object.values(n).forEach(walk);
    };
    walk(JUDGEMENT_SCHEMA);
    expect(objects).toHaveLength(3);
    for (const o of objects) expect(o.additionalProperties).toBe(false);
    expect(JSON.stringify(JUDGEMENT_SCHEMA)).not.toMatch(/minimum|maximum|minLength|maxLength/);
  });

  it("uses a configured base URL", async () => {
    fetchMock.mockResolvedValue(messageResponse(JSON.stringify(reply)));
    await createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY, baseUrl: "https://gw.example.com/anthropic/" }).judge(input);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://gw.example.com/anthropic/v1/messages");
  });

  it("retries once on 429, honouring retry-after", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, "rate limited", { "retry-after": "3" }))
      .mockResolvedValueOnce(messageResponse(JSON.stringify(reply)));

    const pending = createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await pending).risk).toBe(0.35);
  });

  it("caps retry-after at 10 s", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(errorResponse(529, "overloaded", { "retry-after": "120" }))
      .mockResolvedValueOnce(messageResponse(JSON.stringify(reply)));

    const pending = createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await pending;
  });

  it("gives up after one retry on repeated 5xx", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => errorResponse(503, "unavailable", { "retry-after": "0" }));

    const pending = createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input);
    const assertion = expect(pending).rejects.toThrow(/HTTP 503.*unavailable/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 and never leaks the key in the error", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, `invalid x-api-key ${KEY}`));

    const err = await createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input).catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(OpendrsError);
    expect((err as OpendrsError).code).toBe("llm");
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("aborts after 60 s", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );

    const pending = createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input);
    const assertion = expect(pending).rejects.toThrow(/timed out after 60 s/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure as an llm error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input)).rejects.toThrow(/fetch failed/);
  });

  it("treats a refusal as an error rather than a score", async () => {
    fetchMock.mockResolvedValue(messageResponse("", "refusal"));
    await expect(createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input)).rejects.toThrow(/refus/);
  });

  it("rejects an unparseable reply", async () => {
    fetchMock.mockResolvedValue(messageResponse("Looks safe to me!"));
    await expect(createAnthropicProvider({ model: "claude-sonnet-5", apiKey: KEY }).judge(input)).rejects.toBeInstanceOf(OpendrsError);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAiProvider } from "../../src/llm/openai.js";
import { JUDGEMENT_SCHEMA } from "../../src/llm/schema.js";
import { VERIFY_SCHEMA, VERIFY_SYSTEM_PROMPT } from "../../src/llm/verify.js";

const KEY = "sk-openai-SECRET";
const input = { title: "t", diff: "[hunk 1]\n+x", files: ["src/a.ts"], hunks: [{ id: 1, file: "src/a.ts", line: 1 }], truncated: false };
const reply = JSON.stringify({ risk: 0.6, confidence: 9, rationale: "drops auth check", hunks: [{ hunk: 1, category: "security", confidence: 9, reason: "auth" }], risky_snippets: [] });
const completion = (content: string) => Response.json({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("openai-compatible provider", () => {
  it("posts chat/completions with the strict judge schema and parses the message content", async () => {
    fetchMock.mockResolvedValue(completion(reply));

    const j = await createOpenAiProvider({ model: "gpt-x", apiKey: KEY }).judge(input);

    expect(j.risk).toBe(0.6);
    expect(j.hunks).toEqual([{ file: "src/a.ts", line: 1, category: "security", safe: false, confidence: 9, reason: "auth" }]);
    expect(j.truncated).toBe(false);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "gpt-x",
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "judgement", schema: JUDGEMENT_SCHEMA, strict: true } },
    });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("talks to a local server without a key", async () => {
    fetchMock.mockResolvedValue(completion(reply));
    await createOpenAiProvider({ model: "llama3", baseUrl: "http://localhost:11434/v1/" }).judge(input);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.headers).not.toHaveProperty("authorization");
  });

  it("retries once on a 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: { message: "busy" } }, { status: 502, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(completion(reply));
    await createOpenAiProvider({ model: "gpt-x", apiKey: KEY }).judge(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails clearly when the reply has no message content", async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [] }));
    await expect(createOpenAiProvider({ model: "gpt-x", apiKey: KEY }).judge(input)).rejects.toThrow(/no message content/);
  });
});

describe("openai-compatible provider verify", () => {
  const candidate = { id: "hunk:src/a.ts:1", kind: "hunk" as const, file: "src/a.ts", line: 1, text: "edits a fix", excerpt: "+x", status: "unknown" as const };
  const verifyInput = { candidates: [candidate], partners: {} };
  const verdicts = JSON.stringify({ verdicts: [{ candidate: 1, action: "keep", droppedClass: null, status: "pre_existing", citedLine: null, reason: "r", confidence: 5 }] });

  it("posts the strict verify schema and returns verdicts with usage", async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [{ index: 0, message: { role: "assistant", content: verdicts }, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 40 } }));
    const out = await createOpenAiProvider({ model: "gpt-x", apiKey: KEY }).verify!(verifyInput);
    expect(out).toEqual({ verdicts: [{ id: candidate.id, action: "keep", status: "pre_existing", reason: "r", confidence: 5 }], usage: { inputTokens: 300, outputTokens: 40 } });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "verification", schema: VERIFY_SCHEMA, strict: true } });
    expect(body.messages[0]).toEqual({ role: "system", content: VERIFY_SYSTEM_PROMPT });
  });

  it("fails clearly when the reply has no message content", async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [] }));
    await expect(createOpenAiProvider({ model: "gpt-x", apiKey: KEY }).verify!(verifyInput)).rejects.toThrow(/no message content/);
  });
});

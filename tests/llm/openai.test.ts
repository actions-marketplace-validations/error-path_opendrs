import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAiProvider } from "../../src/llm/openai.js";

const KEY = "sk-openai-SECRET";
const input = { title: "t", diff: "+x", files: ["src/a.ts"] };
const reply = JSON.stringify({ risk: 0.6, rationale: "drops auth check", risky_snippets: [] });
const completion = (content: string) => Response.json({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("openai-compatible provider", () => {
  it("posts chat/completions in JSON mode and parses the message content", async () => {
    fetchMock.mockResolvedValue(completion(reply));

    const j = await createOpenAiProvider({ model: "gpt-x", apiKey: KEY }).judge(input);

    expect(j.risk).toBe(0.6);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "gpt-x", temperature: 0, response_format: { type: "json_object" } });
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

import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PROMPT_INJECTION_DEFAULT_MODEL, PROMPT_INJECTION_MAX_REQUEST_BYTES } from "@paperclipai/shared";
import { parsePromptInjectionVerdict, promptInjectionInput, promptInjectionRequestFits, runPromptInjectionProvider } from "../services/prompt-injection-provider.js";
const input = { credential: "fixture-key", model: PROMPT_INJECTION_DEFAULT_MODEL,
  prompt: promptInjectionInput("ordinary result", { name: "read", type: "builtin" }) };
const body = (content: string, finish = "stop") => ({ id: "request-1", model: input.model, created: 1,
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.00001 } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
describe("prompt injection provider", () => {
  it.each(['{}', '{"violation":false,"findings":["instruction_hijack"]}', '{"violation":true,"findings":[]}',
    '{"violation":true,"findings":["other"]}', '{"violation":false,"findings":[],"reason":"x"}',
    '```json\n{"violation":false,"findings":[]}\n```', 'I refuse.', '',
  ])("rejects invalid verdict %s", text => expect(parsePromptInjectionVerdict(text)).toBeNull());
  it("sends the exact policy/model/headers and captures usage", async () => {
    const fetch = vi.fn(async () => json(body('{"violation":false,"findings":[]}')));
    expect(await runPromptInjectionProvider(input, { fetch })).toMatchObject({ verdict: { violation: false, findings: [] }, receipt: { costStatus: "reported", inputTokens: 100, outputTokens: 20 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init.headers).get("x-openrouter-title")).toBe("Paperclip");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: input.model, max_tokens: 4096, usage: { include: true }, messages: [
      { role: "system", content: [{ type: "text", text: expect.stringContaining("tool-result-v1") }] }, { role: "user", content: input.prompt },
    ] });
    expect(JSON.parse(String(init.body)).tools).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["length", "content_filter"])("rejects %s output while preserving charges", async finish => {
    const result = await runPromptInjectionProvider(input, { fetch: async () => json(body('{"violation":false,"findings":[]}', finish)) });
    expect(result).toMatchObject({ errorCode: "invalid_output", receipt: { costStatus: "reported" } });
  });
  it("preserves charges for malformed output", async () => {
    expect(await runPromptInjectionProvider(input, { fetch: async () => json(body("not JSON")) })).toMatchObject({ errorCode: "invalid_output", receipt: { costStatus: "reported" } });
  });
  it.each([[401,"provider_auth_failed"], [429,"provider_rate_limited"], [500,"provider_failed"], [400,"input_too_large"]])("maps HTTP %s without retry or raw diagnostics", async (status, code) => {
    const fetch = vi.fn(async () => json({ error: { message: "context_length exceeded PRIVATE BODY" } }, status as number));
    const result = await runPromptInjectionProvider(input, { fetch });
    expect(result.errorCode).toBe(code); expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE BODY");
    expect(result.receipt.costStatus).toBe(status === 500 ? "unpriced" : "estimated");
  });
  it("rejects oversized data before dispatch rather than truncating", async () => {
    const fetch = vi.fn();
    expect(await runPromptInjectionProvider({ ...input, prompt: "x".repeat(256*1024) }, { fetch })).toMatchObject({ errorCode: "input_too_large" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([PROMPT_INJECTION_DEFAULT_MODEL, "publisher/" + '界"'.repeat(100)])("caps the complete serialized HTTP body for %s", async model => {
    const fetch = vi.fn(async () => json(body('{"violation":false,"findings":[]}')));
    const prefix = 'escaped "data" with\nmultibyte 界';
    await runPromptInjectionProvider({ ...input, model, prompt: prefix }, { fetch });
    const initialBody = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    const prompt = prefix + "x".repeat(PROMPT_INJECTION_MAX_REQUEST_BYTES - Buffer.byteLength(initialBody));
    fetch.mockClear();
    expect(promptInjectionRequestFits(prompt, model)).toBe(true);
    expect(await runPromptInjectionProvider({ ...input, model, prompt }, { fetch })).toHaveProperty("verdict");
    const finalBody = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(Buffer.byteLength(finalBody)).toBe(PROMPT_INJECTION_MAX_REQUEST_BYTES);
    expect(JSON.parse(finalBody).messages[1].content).toBe(prompt);
    fetch.mockClear();
    expect(promptInjectionRequestFits(prompt + "x", model)).toBe(false);
    expect(await runPromptInjectionProvider({ ...input, model, prompt: prompt + "x" }, { fetch }))
      .toMatchObject({ errorCode: "input_too_large", noProviderWork: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts a real delayed HTTP request while unrelated requests remain responsive", async () => {
    let closed = false, calls = 0;
    const server = createServer((req, res) => {
      if (req.url === "/health") { res.end("ok"); return; }
      calls++; req.resume(); res.on("close", () => { closed = true; });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
    try {
      const pending = runPromptInjectionProvider(input, { deadlineMs: 250, fetch: (_url, init) => fetch(base + "/classify", init) });
      expect(await (await fetch(base + "/health")).text()).toBe("ok");
      const result = await pending;
      expect(result).toMatchObject({ errorCode: "timeout", receipt: { costStatus: "unpriced" } });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(closed).toBe(true); expect(calls).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("does not dispatch after caller cancellation", async () => {
    const controller = new AbortController(); controller.abort(); const fetch = vi.fn();
    await expect(runPromptInjectionProvider({ ...input, signal: controller.signal }, { fetch })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

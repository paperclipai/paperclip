import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerSafeCallRoute } from "../../src/routes/safe-call.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

function baseExternal() {
  return {
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST" as const,
    headers: { Authorization: "Bearer t" },
    bodyTemplate: { model: "gpt", messages: [{ role: "user", content: "{{prompt}}" }] },
    responsePath: "choices.0.message.content",
  };
}

describe("POST /safe-call", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("runs full roundtrip", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m-1", anonymizedText: "Hi [PERSON_A]",
        findings: [], warnings: [],
      }),
      deanonymize: vi.fn().mockReturnValue({ text: "Hi Max back" }),
      close: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "Hi [PERSON_A] back" } }] }),
        { status: 200, headers: { "content-type": "application/json" } })
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: {
        prompt: "Hi Max", targetLlm: "gpt", agent: "luna",
        external: baseExternal(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: false, text: "Hi Max back" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt", messages: [{ role: "user", content: "Hi [PERSON_A]" }],
    });
  });

  it("propagates anonymize block without calling external", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({ blocked: true, reason: "art_9_data_detected" }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    const fetchFn = vi.fn();
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { prompt: "x", targetLlm: "g", agent: "l", external: baseExternal() },
    });
    expect(res.json()).toEqual({ blocked: true, reason: "art_9_data_detected" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("502 when external returns non-2xx", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m", anonymizedText: "x", findings: [], warnings: [],
      }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response("oops", { status: 500 }));
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { prompt: "x", targetLlm: "g", agent: "l", external: baseExternal() },
    });
    expect(res.statusCode).toBe(502);
  });

  it("502 when responsePath extraction throws", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m", anonymizedText: "x", findings: [], warnings: [],
      }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    // response shape has `content: 123` (number) — extractByPath will throw "not a string"
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 123 } }] }),
        { status: 200, headers: { "content-type": "application/json" } })
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { prompt: "x", targetLlm: "g", agent: "l", external: baseExternal() },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "response_path_invalid",
      message: expect.stringContaining("not a string"),
    });
  });

  it("502 when fetch rejects (network error)", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m", anonymizedText: "x", findings: [], warnings: [],
      }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { prompt: "x", targetLlm: "g", agent: "l", external: baseExternal() },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: "external_unreachable",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("502 when external response is not valid JSON", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m", anonymizedText: "x", findings: [], warnings: [],
      }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { prompt: "x", targetLlm: "g", agent: "l", external: baseExternal() },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("external_invalid_json");
  });
});

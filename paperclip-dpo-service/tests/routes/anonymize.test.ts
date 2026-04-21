import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerAnonymizeRoute } from "../../src/routes/anonymize.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

function makeApp(dpo: Dpo): FastifyInstance {
  const app = Fastify();
  registerAuth(app, { sharedKey: KEY });
  registerAnonymizeRoute(app, { dpo });
  return app;
}

describe("POST /anonymize", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("returns pseudonymised text on success", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m-1",
        anonymizedText: "Hi [PERSON_A]",
        findings: [{ type: "PERSON", count: 1, confidence: "high" }],
        warnings: [],
      }),
      deanonymize: vi.fn(),
      close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "Hi Max", targetLlm: "gpt-4o", agent: "luna" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      blocked: false,
      anonymizedText: "Hi [PERSON_A]",
      mappingId: "m-1",
    });
    expect(dpo.anonymize).toHaveBeenCalledWith({
      text: "Hi Max", targetLlm: "gpt-4o", agent: "luna", tenantId: undefined,
    });
  });

  it("propagates art_9 block", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({ blocked: true, reason: "art_9_data_detected" }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x", targetLlm: "gpt-4o", agent: "luna" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: true, reason: "art_9_data_detected" });
  });

  it("propagates dpo_unavailable block", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({ blocked: true, reason: "dpo_unavailable" }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x", targetLlm: "gpt-4o", agent: "luna" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: true, reason: "dpo_unavailable" });
  });

  it("400 on missing required field", async () => {
    const dpo = { anonymize: vi.fn(), deanonymize: vi.fn(), close: vi.fn() };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("401 when key missing", async () => {
    const dpo = { anonymize: vi.fn(), deanonymize: vi.fn(), close: vi.fn() };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "content-type": "application/json" },
      payload: { text: "x", targetLlm: "g", agent: "l" },
    });
    expect(res.statusCode).toBe(401);
  });
});

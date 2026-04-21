import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerDeanonymizeRoute } from "../../src/routes/deanonymize.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

function makeApp(dpo: Dpo): FastifyInstance {
  const app = Fastify();
  registerAuth(app, { sharedKey: KEY });
  registerDeanonymizeRoute(app, { dpo });
  return app;
}

describe("POST /deanonymize", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("returns deanonymised text", async () => {
    const dpo = {
      anonymize: vi.fn(),
      deanonymize: vi.fn().mockReturnValue({ text: "Hi Max" }),
      close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/deanonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { mappingId: "m-1", text: "Hi [PERSON_A]" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "Hi Max" });
    expect(dpo.deanonymize).toHaveBeenCalledWith({ mappingId: "m-1", text: "Hi [PERSON_A]" });
  });

  it("404 when mappingId unknown", async () => {
    const dpo = {
      anonymize: vi.fn(),
      deanonymize: vi.fn().mockImplementation(() => {
        throw new Error("mapping not found: m-x");
      }),
      close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/deanonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { mappingId: "m-x", text: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 on bad body", async () => {
    const dpo = { anonymize: vi.fn(), deanonymize: vi.fn(), close: vi.fn() };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/deanonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { mappingId: "m-1" },
    });
    expect(res.statusCode).toBe(400);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../src/auth.js";

describe("auth", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerAuth(app, { sharedKey: "correct-secret-32-bytes-xxxxxxxxxxx" });
    app.get("/protected", async () => ({ ok: true }));
    app.get("/health", { config: { noAuth: true } }, async () => ({ ok: true }));
    await app.ready();
  });

  it("401 when header missing", async () => {
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("401 when header wrong", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-dpo-key": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 when header correct", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-dpo-key": "correct-secret-32-bytes-xxxxxxxxxxx" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("bypasses auth for routes marked noAuth", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

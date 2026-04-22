import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoute } from "../../src/routes/health.js";

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.useFakeTimers();
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it("reports classifier reachable on 200 ping", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    registerHealthRoute(app, { classifierUrl: "http://x:1234", fetchFn });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", classifier: "reachable" });
  });

  it("reports classifier unreachable on fetch failure", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    registerHealthRoute(app, { classifierUrl: "http://x:1234", fetchFn });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", classifier: "unreachable" });
  });

  it("reports classifier unreachable on non-2xx response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("no", { status: 503 }));
    registerHealthRoute(app, { classifierUrl: "http://x:1234", fetchFn });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", classifier: "unreachable" });
  });

  it("caches result for 10s", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    registerHealthRoute(app, { classifierUrl: "http://x:1234", fetchFn });
    await app.ready();
    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/health" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11000);
    await app.inject({ method: "GET", url: "/health" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

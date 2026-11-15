import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ChaosApi, ChaosApiError, rateLimitDelayMs } from "./api.js";

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  server = null;
});

async function serve(handler: (count: number) => { status: number; body: unknown }) {
  let count = 0;
  const arrivals: number[] = [];
  server = createServer((_request, response) => {
    count += 1;
    arrivals.push(performance.now());
    const reply = handler(count);
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, count: () => count, arrivals };
}

describe("ChaosApi rate limits", () => {
  it("retries a GET the server rate-limited, after the delay it asked for", async () => {
    const target = await serve(count => count <= 2
      ? { status: 429, body: { error: "Too many concurrent issue-list requests", retryAfterSeconds: 0.05 } }
      : { status: 200, body: [{ id: "c1" }] });
    await expect(new ChaosApi(target.url).get("/api/issues")).resolves.toEqual([{ id: "c1" }]);
    expect(target.count()).toBe(3);
    const [first, second, third] = target.arrivals;
    expect(second! - first!).toBeGreaterThanOrEqual(45);
    expect(third! - second!).toBeGreaterThanOrEqual(95);
  });

  it("does not repeat a write the server rate-limited", async () => {
    const target = await serve(() => ({ status: 429, body: { retryAfterSeconds: 0.01 } }));
    await expect(new ChaosApi(target.url).post("/api/issues/i1/comments", { body: "x" })).rejects.toBeInstanceOf(ChaosApiError);
    expect(target.count()).toBe(1);
  });

  it("gives up after a bounded number of attempts", async () => {
    const target = await serve(() => ({ status: 429, body: { retryAfterSeconds: 0.01 } }));
    await expect(new ChaosApi(target.url, 10_000, 3).get("/api/issues")).rejects.toThrow(/returned 429/);
    expect(target.count()).toBe(3);
  });

  it("reads the delay from Retry-After or the body, capped, and defaults to one second", () => {
    const response = (status: number, retryAfter: string | null = null) => ({ status, headers: { get: () => retryAfter } });
    expect(rateLimitDelayMs(response(200), "")).toBeNull();
    expect(rateLimitDelayMs(response(429, "2"), "")).toBe(2_000);
    expect(rateLimitDelayMs(response(429), JSON.stringify({ retryAfterSeconds: 3 }))).toBe(3_000);
    expect(rateLimitDelayMs(response(429, "600"), "")).toBe(10_000);
    expect(rateLimitDelayMs(response(429), "not json")).toBe(1_000);
  });
});

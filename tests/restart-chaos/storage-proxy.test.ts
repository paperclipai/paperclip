import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startStorageFaultProxy } from "./storage-proxy.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function upstream() {
  const seen: string[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    let body = "";
    incoming.on("data", chunk => { body += chunk; });
    incoming.on("end", () => { seen.push(`${incoming.method} ${incoming.url} ${body}`); outgoing.writeHead(200, { etag: "\"e1\"" }).end("stored"); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  closers.push(async () => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${address.port}`, seen };
}

async function proxyFor(endpoint: string, random?: () => number) {
  const proxy = await startStorageFaultProxy(endpoint, random);
  closers.push(() => proxy.close());
  return proxy;
}

describe("storage fault proxy", () => {
  it("passes requests through untouched when no rule matches", async () => {
    const store = await upstream();
    const proxy = await proxyFor(store.endpoint);
    const response = await fetch(`${proxy.endpoint}/bucket/key`, { method: "PUT", body: "bytes" });
    expect([response.status, await response.text(), response.headers.get("etag")]).toEqual([200, "stored", "\"e1\""]);
    expect(store.seen).toEqual(["PUT /bucket/key bytes"]);
    expect(proxy.counts()).toMatchObject({ requests: 1, injected: 0, byMethod: { PUT: 1 } });
  });

  it("injects a store outage for matching requests only, for a bounded number of hits", async () => {
    const store = await upstream();
    const proxy = await proxyFor(store.endpoint);
    proxy.setRules([{ fault: { kind: "outage" }, methods: ["PUT"], pathIncludes: "workspace-snapshots", remaining: 2 }]);
    const put = () => fetch(`${proxy.endpoint}/bucket/c/workspace-snapshots/w/s.pcws`, { method: "PUT", body: "x" });
    const first = await put();
    expect([first.status, await first.text()]).toEqual([503, expect.stringContaining("<Code>ServiceUnavailable</Code>")]);
    expect((await put()).status).toBe(503);
    expect((await put()).status).toBe(200);
    expect((await fetch(`${proxy.endpoint}/bucket/c/run-logs/r`)).status).toBe(200);
    expect(store.seen).toHaveLength(2);
    expect(proxy.counts()).toMatchObject({ injected: 2, byStatus: { 503: 2, 200: 2 } });
  });

  it("answers SlowDown throttling and expired credentials the way S3 does", async () => {
    const store = await upstream();
    const proxy = await proxyFor(store.endpoint, () => 0);
    proxy.setRules([{ fault: { kind: "errors", rate: 0.5, status: 503, slowDown: true } }]);
    const slow = await fetch(`${proxy.endpoint}/bucket/a`);
    expect([slow.status, await slow.text()]).toEqual([503, expect.stringContaining("<Code>SlowDown</Code>")]);
    proxy.setRules([{ fault: { kind: "expired_credentials" } }]);
    const expired = await fetch(`${proxy.endpoint}/bucket/a`);
    expect([expired.status, await expired.text()]).toEqual([403, expect.stringContaining("<Code>ExpiredToken</Code>")]);
    proxy.clear();
    expect((await fetch(`${proxy.endpoint}/bucket/a`)).status).toBe(200);
  });

  it("delays requests by the configured latency and drops connections on reset", async () => {
    const store = await upstream();
    const proxy = await proxyFor(store.endpoint, () => 0);
    proxy.setRules([{ fault: { kind: "latency", ms: 150 } }]);
    const started = Date.now();
    expect((await fetch(`${proxy.endpoint}/bucket/a`)).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    proxy.setRules([{ fault: { kind: "reset" } }]);
    await expect(fetch(`${proxy.endpoint}/bucket/a`)).rejects.toThrow();
  });

  it("cancels a delayed request when the client goes away and counts store connection failures", async () => {
    const store = await upstream();
    const proxy = await proxyFor(store.endpoint, () => 0);
    proxy.setRules([{ fault: { kind: "latency", ms: 400 } }]);
    const controller = new AbortController();
    const pending = fetch(`${proxy.endpoint}/bucket/late`, { signal: controller.signal }).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(store.seen).toEqual([]);
    const dead = await proxyFor("http://127.0.0.1:1");
    expect((await fetch(`${dead.endpoint}/bucket/a`)).status).toBe(502);
    expect(dead.counts()).toMatchObject({ requests: 1, byStatus: { 502: 1 } });
  });
});


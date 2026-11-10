import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { bandwidthDraw, ByteRate, paced } from "./storage-bandwidth.js";
import { storageFaultRules } from "./storage-chaos.js";
import { startStorageFaultProxy } from "./storage-proxy.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

const MiB = 1024 * 1024;

async function store(responseBytes: number) {
  const received: number[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    let size = 0;
    incoming.on("data", (chunk: Buffer) => { size += chunk.length; });
    incoming.on("end", () => { received.push(size); outgoing.writeHead(200, { "content-length": responseBytes }).end(Buffer.alloc(responseBytes, 7)); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  closers.push(async () => { server.closeAllConnections(); server.close(); });
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, received };
}

async function proxyFor(endpoint: string) {
  const proxy = await startStorageFaultProxy(endpoint, () => 0);
  closers.push(() => proxy.close());
  return proxy;
}

async function timed(work: () => Promise<unknown>) {
  const started = Date.now();
  await work();
  return Date.now() - started;
}

describe("storage bandwidth cap", () => {
  it("spaces reservations at the configured rate and shares the rate between callers", () => {
    let now = 1_000;
    const rate = new ByteRate(1_000, () => now);
    expect(rate.reserve(500)).toBe(500);
    expect(rate.reserve(500)).toBe(1_000);
    now += 1_000;
    expect(rate.reserve(250)).toBe(250);
    now += 5_000;
    expect(rate.reserve(100)).toBe(100);
    rate.release();
    expect(rate.reserve(1_000_000)).toBe(0);
    expect(() => new ByteRate(0)).toThrow(/positive/);
  });

  it("paces a stream without changing its bytes", async () => {
    const source = Buffer.from(Array.from({ length: 96 * 1024 }, (_, index) => index % 251));
    const chunks: Buffer[] = [];
    const elapsed = await timed(async () => {
      for await (const chunk of Readable.from([source]).pipe(paced(new ByteRate(256 * 1024), 16 * 1024))) chunks.push(chunk as Buffer);
    });
    expect(Buffer.concat(chunks).equals(source)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(330);
  });

  it("caps upload and download bandwidth through the proxy for a slow-store rule", async () => {
    const upstream = await store(256 * 1024);
    const proxy = await proxyFor(upstream.endpoint);
    const put = () => fetch(`${proxy.endpoint}/bucket/c/workspace-snapshots/w/s/a.pcws?partNumber=1&uploadId=u`,
      { method: "PUT", body: Buffer.alloc(512 * 1024, 1) }).then(response => response.arrayBuffer());
    expect(await timed(put)).toBeLessThan(500);
    proxy.setRules([{ fault: { kind: "latency", ms: 0, bytesPerSecond: MiB } }]);
    const capped = await timed(put);
    expect(capped).toBeGreaterThanOrEqual(600);
    expect(upstream.received).toEqual([512 * 1024, 512 * 1024]);
    const download = await timed(() => fetch(`${proxy.endpoint}/bucket/c/workspace-snapshots/w/s/a.pcws`).then(response => response.arrayBuffer()));
    expect(download).toBeGreaterThanOrEqual(200);
  });

  it("shares one cap between parallel requests in a window", async () => {
    const upstream = await store(0);
    const proxy = await proxyFor(upstream.endpoint);
    proxy.setRules([{ fault: { kind: "latency", ms: 0, bytesPerSecond: MiB } }]);
    const part = (number: number) => fetch(`${proxy.endpoint}/bucket/c/workspace-snapshots/w/s/a.pcws?partNumber=${number}&uploadId=u`,
      { method: "PUT", body: Buffer.alloc(256 * 1024, number) }).then(response => response.arrayBuffer());
    expect(await timed(() => Promise.all([1, 2, 3, 4].map(part)))).toBeGreaterThanOrEqual(850);
    expect(upstream.received).toEqual([256 * 1024, 256 * 1024, 256 * 1024, 256 * 1024]);
  });

  it("releases an in-flight transfer when its window ends", async () => {
    const upstream = await store(4 * MiB);
    const proxy = await proxyFor(upstream.endpoint);
    proxy.setRules([{ fault: { kind: "latency", ms: 0, bytesPerSecond: 256 * 1024 } }]);
    const download = timed(() => fetch(`${proxy.endpoint}/bucket/c/workspace-snapshots/w/s/a.pcws`).then(response => response.arrayBuffer()));
    await new Promise(resolve => setTimeout(resolve, 300));
    proxy.clear();
    expect(await download).toBeLessThan(3_000);
  });

  it("gives every ST2 window a bandwidth cap between 2 and 16 MiB/s", () => {
    for (const draw of [0, 0.5, 0.999]) {
      const [rule] = storageFaultRules("ST2", () => draw);
      expect(rule!.fault).toMatchObject({ kind: "latency", bytesPerSecond: bandwidthDraw(() => draw) });
    }
    expect([bandwidthDraw(() => 0), bandwidthDraw(() => 1)]).toEqual([2 * MiB, 16 * MiB]);
  });
});

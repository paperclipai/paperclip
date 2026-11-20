import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";

type Seen = { method: string; key: string; body: Buffer };
const seen: Seen[] = [];
let respond: (req: IncomingMessage, res: ServerResponse, index: number) => void = (_req, res) => res.end();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk as Buffer));
  req.on("end", () => {
    seen.push({ method: req.method ?? "", key: (req.url ?? "").split("?")[0]!.split("/").pop() ?? "", body: Buffer.concat(chunks) });
    respond(req, res, seen.length - 1);
  });
});
let endpoint = "";
const savedEnv = { ...process.env };

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
});

afterAll(async () => {
  process.env = savedEnv;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => { seen.length = 0; vi.spyOn(Math, "random").mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

const SLOW_DOWN = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>req-503</RequestId></Error>`;

function throttleFirstPuts(count: number) {
  respond = (req, res, index) => {
    if (req.method === "PUT" && index < count) {
      res.writeHead(503, { "content-type": "application/xml" });
      res.end(SLOW_DOWN);
      return;
    }
    res.writeHead(200, { etag: '"saved"' });
    res.end();
  };
}

function storage() {
  return createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true }));
}

const sha256 = "0".repeat(64);

describe("S3 throttling of small uploads without a source file", () => {
  it("resends a small streamed upload after SlowDown", async () => {
    const content = Buffer.from("skill package archive bytes");
    throttleFirstPuts(1);

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/files.tar.gz",
      originalFilename: "files.tar.gz", contentType: "application/gzip", body: Readable.from([content]),
      byteSize: content.length, sha256 })).resolves.toMatchObject({ byteSize: content.length });

    expect(seen.map(entry => entry.method)).toEqual(["PUT", "PUT"]);
    expect(seen[1]!.body.equals(content)).toBe(true);
  });

  it("keeps backing off a small buffered upload after the SDK's own attempts are throttled", async () => {
    const content = Buffer.from('{"files":[]}');
    throttleFirstPuts(3);

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/manifest.json",
      originalFilename: "manifest.json", contentType: "application/json", body: content }))
      .resolves.toMatchObject({ byteSize: content.length });

    expect(seen.map(entry => entry.method)).toEqual(["PUT", "PUT", "PUT", "PUT"]);
    expect(seen[3]!.body.equals(content)).toBe(true);
  });

  it("rejects a streamed upload that ends before its declared size without sending it", async () => {
    throttleFirstPuts(0);

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/files.tar.gz",
      originalFilename: "files.tar.gz", contentType: "application/gzip", body: Readable.from([Buffer.from("short")]),
      byteSize: 10, sha256 })).rejects.toThrow("S3 upload source was truncated");
    expect(seen.filter(entry => entry.method === "PUT")).toEqual([]);
  });

  it("does not resend a small upload the store refused for good", async () => {
    respond = (_req, res) => {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>denied</Message></Error>`);
    };

    await expect(storage().putFile({ companyId: "company", namespace: "skill-packages", objectKey: "company/skill-packages/files.tar.gz",
      originalFilename: "files.tar.gz", contentType: "application/gzip", body: Readable.from([Buffer.from("bytes")]),
      byteSize: 5, sha256 })).rejects.toMatchObject({ name: "AccessDenied" });
    expect(seen.filter(entry => entry.method === "PUT")).toHaveLength(1);
  });
});

describe("S3 small streamed uploads while the buffer budget is full", () => {
  const MiB = 1024 * 1024;
  const slowDown = (res: ServerResponse) => { res.writeHead(503, { "content-type": "application/xml" }); res.end(SLOW_DOWN); };
  const ok = (res: ServerResponse) => { res.writeHead(200, { etag: '"saved"' }); res.end(); };
  const putStream = (key: string, content: Buffer, signal?: AbortSignal) => storage().putFile({ companyId: "company",
    namespace: "skill-packages", objectKey: `company/skill-packages/${key}`, originalFilename: key, contentType: "application/gzip",
    body: Readable.from([content]), byteSize: content.length, sha256, signal });
  const awsChunkedPayload = (body: Buffer) => {
    const chunks: Buffer[] = [];
    for (let at = 0; at < body.length;) {
      const end = body.indexOf("\r\n", at);
      const size = end < 0 ? Number.NaN : Number.parseInt(body.subarray(at, end).toString(), 16);
      if (!Number.isInteger(size) || size < 0) return undefined;
      if (size === 0) return Buffer.concat(chunks);
      chunks.push(body.subarray(end + 2, end + 2 + size));
      at = end + 4 + size;
    }
    return undefined;
  };
  const puts = (key: string) => seen.filter(entry => entry.method === "PUT" && entry.key === key);

  it("streams another small upload once, intact, and gets the budget back from a failed and a cancelled upload", async () => {
    const held = new Map<string, ServerResponse>();
    let bothHeld!: () => void;
    const holding = new Promise<void>(resolve => { bothHeld = resolve; });
    respond = (req, res) => {
      if (req.method === "PUT" && seen.at(-1)!.key.startsWith("held-")) {
        held.set(seen.at(-1)!.key, res);
        if (held.size === 2) bothHeld();
        return;
      }
      if (req.method === "PUT" && seen.at(-1)!.key === "throttled") return slowDown(res);
      ok(res);
    };
    const cancel = new AbortController();
    const failing = putStream("held-failing", Buffer.alloc(16 * MiB, 1));
    const cancelled = putStream("held-cancelled", Buffer.alloc(16 * MiB, 2), cancel.signal);
    failing.catch(() => undefined);
    cancelled.catch(() => undefined);
    await holding;

    const content = Buffer.from("skill package archive bytes");
    await expect(putStream("fallback", content)).resolves.toMatchObject({ byteSize: content.length });
    expect(puts("fallback").length).toBe(1);
    expect(awsChunkedPayload(puts("fallback")[0]!.body)?.equals(content)).toBe(true);
    await expect(putStream("throttled", content)).rejects.toMatchObject({ name: "SlowDown" });
    expect(puts("throttled").length).toBe(1);

    const refused = held.get("held-failing")!;
    refused.writeHead(403, { "content-type": "application/xml" });
    refused.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>denied</Message></Error>`);
    await expect(failing).rejects.toMatchObject({ name: "AccessDenied" });
    cancel.abort(new Error("upload cancelled"));
    await expect(cancelled).rejects.toThrow();
    held.get("held-cancelled")!.destroy();

    const throttledOnce = new Set<string>();
    respond = (req, res) => {
      const key = seen.at(-1)!.key;
      if (req.method === "PUT" && !throttledOnce.has(key)) { throttledOnce.add(key); return slowDown(res); }
      ok(res);
    };
    const first = Buffer.alloc(16 * MiB, 3);
    const second = Buffer.alloc(16 * MiB, 4);
    const outcomes = await Promise.allSettled([putStream("after-first", first), putStream("after-second", second)]);
    expect(outcomes.map(outcome => outcome.status === "fulfilled" ? "saved" : (outcome.reason as Error).name)).toEqual(["saved", "saved"]);
    expect(puts("after-first").length).toBe(2);
    expect(puts("after-second").length).toBe(2);
    expect(puts("after-first")[1]!.body.equals(first)).toBe(true);
    expect(puts("after-second")[1]!.body.equals(second)).toBe(true);
  });
});

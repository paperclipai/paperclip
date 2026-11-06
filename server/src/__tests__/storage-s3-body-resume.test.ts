import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storageFailureDiagnosticsFor } from "../storage/failure-diagnostics.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { MAX_S3_BODY_RESUMES } from "../storage/s3-resumable-body.js";

// A GetObject body that loses its socket after the headers arrived. Restoring
// a saved workspace or harness backup streams one large object; a single reset
// used to fail the whole recovery even though S3 still held the same bytes.

const OBJECT = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
const ETAG = "\"etag-1\"";

interface SeenRequest { range: string | undefined; ifMatch: string | undefined }
let seen: SeenRequest[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end();
const server = createServer((req, res) => {
  seen.push({ range: req.headers.range, ifMatch: req.headers["if-match"] as string | undefined });
  req.resume();
  req.on("end", () => handler(req, res));
});
let endpoint = "";
const savedEnv = { ...process.env };

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.AWS_ACCESS_KEY_ID = "fixture-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "fixture-secret-key";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
});

afterAll(async () => {
  process.env = savedEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => { seen = []; });

function provider() {
  return createS3StorageProvider({ bucket: "bucket", region: "us-east-1", endpoint, forcePathStyle: true });
}

function parseRange(header: string | undefined) {
  const match = /^bytes=(\d+)-(\d+)?$/.exec(header ?? "");
  return match ? { start: Number(match[1]), end: match[2] === undefined ? OBJECT.length - 1 : Number(match[2]) } : null;
}

/** Serve OBJECT like S3, cutting the socket after `cutAfter` bytes when it returns a number. */
function objectServer(options: { etag?: string | null; cutAfter: (requestIndex: number) => number | null; precondition?: (ifMatch: string | undefined) => boolean }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const index = seen.length - 1;
    const etag = options.etag === undefined ? ETAG : options.etag;
    if (options.precondition && !options.precondition(req.headers["if-match"] as string | undefined)) {
      res.writeHead(412, { "content-type": "application/xml", "x-amz-request-id": `req-${index}` });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>changed</Message></Error>`);
      return;
    }
    const range = parseRange(req.headers.range);
    const body = range ? OBJECT.subarray(range.start, range.end + 1) : OBJECT;
    res.writeHead(range ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${OBJECT.length}` } : {}),
      ...(etag ? { etag } : {}),
      "x-amz-request-id": `req-${index}`,
    });
    const cut = options.cutAfter(index);
    if (cut === null) { res.end(body); return; }
    res.write(body.subarray(0, cut), () => req.socket.destroy());
  };
}

async function drain(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe("S3 object body resumption", () => {
  it("resumes a body cut off mid-download from the delivered offset of the same object version", async () => {
    handler = objectServer({ cutAfter: (index) => index === 0 ? 1000 : null });

    const object = await provider().getObject({ objectKey: "company/workspace-snapshots/w/s/a.pcws" });
    const received = await drain(object.stream);

    expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(OBJECT).digest("hex"));
    expect(seen).toEqual([
      { range: undefined, ifMatch: undefined },
      { range: "bytes=1000-4095", ifMatch: ETAG },
    ]);
    expect(object.contentLength).toBe(OBJECT.length);
  });

  it("keeps a caller's byte range when it resumes", async () => {
    handler = objectServer({ cutAfter: (index) => index === 0 ? 10 : null });

    const object = await provider().getObject({ objectKey: "k", range: { start: 100, end: 1123 } });
    const received = await drain(object.stream);

    expect(received.equals(OBJECT.subarray(100, 1124))).toBe(true);
    expect(seen.map((request) => request.range)).toEqual(["bytes=100-1123", "bytes=110-1123"]);
  });

  it("stops after a bounded number of resumes and reports the final body failure", async () => {
    handler = objectServer({ cutAfter: () => 16 });

    const object = await provider().getObject({ objectKey: "k" });
    const error = await drain(object.stream).catch((err: unknown) => err);

    expect(error).toMatchObject({ message: "aborted", code: "ECONNRESET" });
    expect(seen).toHaveLength(1 + MAX_S3_BODY_RESUMES);
    expect(seen.map((request) => request.range)).toEqual([undefined, "bytes=16-4095", "bytes=32-4095", "bytes=48-4095"]);
    expect(storageFailureDiagnosticsFor(error)).toMatchObject({
      operation: "read_object_body",
      errorCode: "ECONNRESET",
      requestId: `req-${MAX_S3_BODY_RESUMES}`,
      attempts: 1 + MAX_S3_BODY_RESUMES,
    });
  });

  it("refuses to splice bytes from a replaced object", async () => {
    handler = objectServer({ cutAfter: (index) => index === 0 ? 100 : null, precondition: (ifMatch) => ifMatch === undefined });

    const object = await provider().getObject({ objectKey: "k" });
    const error = await drain(object.stream).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "PreconditionFailed" });
    expect(seen).toHaveLength(2);
    expect(storageFailureDiagnosticsFor(error)).toMatchObject({ operation: "get_object", httpStatus: 412 });
  });

  it("does not resume an object without an ETag to pin its version", async () => {
    handler = objectServer({ etag: null, cutAfter: (index) => index === 0 ? 100 : null });

    const object = await provider().getObject({ objectKey: "k" });
    const error = await drain(object.stream).catch((err: unknown) => err);

    expect(error).toMatchObject({ message: "aborted", code: "ECONNRESET" });
    expect(seen).toHaveLength(1);
  });

  it("does not resume after the caller cancels the read", async () => {
    const controller = new AbortController();
    handler = (req, res) => {
      objectServer({ cutAfter: (index) => index === 0 ? 100 : null })(req, res);
      controller.abort();
    };

    // The abort can surface from send() or from the body; neither may resume.
    const error = await provider().getObject({ objectKey: "k", signal: controller.signal })
      .then((object) => drain(object.stream)).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(1);
  });

  it("delivers a resumed body intact through a slow pipeline, as the workspace snapshot loader reads it", async () => {
    const large = Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, index) => (index * 7) % 256));
    handler = (req, res) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
      const body = range ? large.subarray(Number(range[1]), Number(range[2]) + 1) : large;
      res.writeHead(range ? 206 : 200, { "content-type": "application/octet-stream", "content-length": String(body.length), etag: ETAG });
      if (range) { res.end(body); return; }
      res.write(body.subarray(0, 700_000), () => req.socket.destroy());
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), "pc-s3-resume-test-"));
    try {
      const object = await provider().getObject({ objectKey: "k" });
      const digest = createHash("sha256"); let size = 0;
      const observed = new Transform({ transform(bytes, _encoding, callback) {
        size += bytes.length; digest.update(bytes); setImmediate(() => callback(null, bytes));
      } });
      await pipeline(object.stream, observed, createWriteStream(path.join(dir, "ciphertext"), { flags: "wx" }));

      expect(size).toBe(large.length);
      expect(digest.digest("hex")).toBe(createHash("sha256").update(large).digest("hex"));
      expect((await readFile(path.join(dir, "ciphertext"))).equals(large)).toBe(true);
      // The reset can drop bytes still in flight; resume starts at what arrived.
      expect(seen).toHaveLength(2);
      const resumedAt = Number(/^bytes=(\d+)-/.exec(seen[1]!.range ?? "")?.[1]);
      expect(resumedAt).toBeGreaterThan(0);
      expect(resumedAt).toBeLessThanOrEqual(700_000);
      expect(seen[1]).toEqual({ range: `bytes=${resumedAt}-${large.length - 1}`, ifMatch: ETAG });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases the response when the consumer stops reading", async () => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    handler = (req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(OBJECT.length), etag: ETAG });
      res.write(OBJECT.subarray(0, 512));
      req.socket.once("close", closed);
    };

    const object = await provider().getObject({ objectKey: "k" });
    for await (const _chunk of object.stream) break;

    await socketClosed;
    expect(seen).toHaveLength(1);
  });
});

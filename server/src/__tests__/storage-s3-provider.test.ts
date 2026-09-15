import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { Readable } from "node:stream";
import { createS3StorageProvider } from "../storage/s3-provider.js";

describe("S3 streaming uploads", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.unstubAllEnvs();
  });

  it("rejects a changing source without an unhandled rejection and allows a retry", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    const accepted: Buffer[] = [];
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("error", () => {});
      request.on("end", () => {
        accepted.push(Buffer.concat(chunks));
        response.writeHead(200, { ETag: '"test-etag"' });
        response.end();
      });
      // A broken stream must reject rather than hang until server timeout.
      request.setTimeout(2_000, () => request.destroy());
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test endpoint");
    const provider = createS3StorageProvider({ bucket: "acceptance", region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true });
    const failure = new Error("Repository changed during checkpoint");
    const changed = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw failure;
    })());
    const input = { objectKey: "checkpoint/blob", contentType: "application/octet-stream", contentLength: 14 };
    await expect(provider.putObject({ ...input, body: changed })).rejects.toThrow(failure.message);
    expect(changed.destroyed).toBe(true);
    expect(accepted).toHaveLength(0);

    await provider.putObject({ ...input, body: Readable.from([Buffer.from("complete bytes")]) });
    expect(accepted).toEqual([Buffer.from("complete bytes")]);
    await provider.putObject({ ...input, contentLength: 0, body: Readable.from([]) });
    expect(accepted.at(-1)).toEqual(Buffer.alloc(0));
  }, 10_000);

  it("destroys a remote source when the object store rejects the upload", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    server = createServer((_request, response) => {
      response.writeHead(403, { "Content-Type": "application/xml" });
      response.end("<Error><Code>AccessDenied</Code><Message>Storage unavailable</Message></Error>");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test endpoint");
    const provider = createS3StorageProvider({ bucket: "acceptance", region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true });
    let sent = false;
    const body = new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.from("partial")); } } });
    await expect(provider.putObject({ objectKey: "checkpoint/blob", body,
      contentType: "application/octet-stream", contentLength: 1024 })).rejects.toThrow("Storage unavailable");
    expect(body.destroyed).toBe(true);
  }, 10_000);
});

describe("S3 canceled reads", () => {
  let server: Server | undefined;
  async function endpoint(handler: RequestListener) {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test endpoint");
    return createS3StorageProvider({ bucket: "acceptance", region: "us-east-1", prefix: "tenant",
      endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true });
  }
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    vi.unstubAllEnvs();
  });
  const canceled = "<Error><Code>RequestCanceled</Code><Message>Request is canceled.</Message></Error>";

  it.each(["", "saved bytes"])("retries HTTP 408 before streaming %j", async (bytes) => {
    const requests: string[] = [];
    const provider = await endpoint((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.range}`);
      if (requests.length <= 2) {
        response.writeHead(408, { "Content-Type": "application/xml" });
        response.end(canceled);
      } else {
        response.writeHead(206, { "Content-Length": Buffer.byteLength(bytes), ETag: '"saved"' });
        response.end(bytes);
      }
    });
    const result = await provider.getObject({ objectKey: "checkpoint/blob", range: { start: 2, end: 12 } });
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe(bytes);
    expect(result.contentLength).toBe(Buffer.byteLength(bytes));
    expect(result.etag).toBe('"saved"');
    expect(requests).toEqual(Array(3).fill("GET /acceptance/tenant/checkpoint/blob?x-id=GetObject bytes=2-12"));
  });

  it("surfaces persistent cancellation after three attempts", async () => {
    let requests = 0;
    const provider = await endpoint((_request, response) => {
      requests++;
      response.writeHead(408, { "Content-Type": "application/xml" });
      response.end(canceled);
    });
    await expect(provider.getObject({ objectKey: "checkpoint/blob" })).rejects.toMatchObject({
      name: "RequestCanceled", message: "Request is canceled.", $metadata: { httpStatusCode: 408 },
    });
    expect(requests).toBe(3);
  });

  it.each([[403, "AccessDenied", "Storage unavailable"], [404, "NoSuchKey", "Object not found"],
    [408, "InvalidRequest", "Storage unavailable"]] as const)("does not extend retries for %s %s", async (status, code, message) => {
    let requests = 0;
    const provider = await endpoint((_request, response) => {
      requests++;
      response.writeHead(status, { "Content-Type": "application/xml" });
      response.end(`<Error><Code>${code}</Code><Message>Storage unavailable</Message></Error>`);
    });
    await expect(provider.getObject({ objectKey: "checkpoint/blob" })).rejects.toThrow(message);
    expect(requests).toBe(1);
  });

  it("does not restart a response after handing its stream to the caller", async () => {
    let requests = 0;
    const provider = await endpoint((_request, response) => {
      requests++;
      response.writeHead(200, { "Content-Length": 1024 });
      response.write("partial");
      response.flushHeaders();
    });
    const { stream } = await provider.getObject({ objectKey: "checkpoint/blob" });
    const consumed = (async () => { for await (const _chunk of stream) { /* Drain. */ } })();
    const rejected = expect(consumed).rejects.toThrow();
    server!.closeAllConnections();
    await rejected;
    expect(requests).toBe(1);
  });

  it("does not replay canceled writes", async () => {
    let requests = 0;
    const provider = await endpoint((request, response) => {
      requests++;
      request.resume();
      response.writeHead(408, { "Content-Type": "application/xml" });
      response.end(canceled);
    });
    await expect(provider.putObject({ objectKey: "checkpoint/blob", body: Buffer.from("saved bytes"),
      contentType: "application/octet-stream", contentLength: 11 })).rejects.toThrow("Request is canceled.");
    expect(requests).toBe(1);
  });
});

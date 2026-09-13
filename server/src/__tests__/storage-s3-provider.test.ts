import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
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

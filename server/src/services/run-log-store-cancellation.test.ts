import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDurableRunLogStore } from "./run-log-store.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";

afterEach(() => vi.unstubAllEnvs());

describe("run-log read cancellation", () => {
  it.each(["head", "get", "body"])("closes a stalled S3 %s connection and permits a subsequent read", async (stage) => {
    // Exercise the real SDK against an on-host server. No provider credentials
    // or external network are used by this cancellation regression.
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-abort-"));
    let recover = false;
    let closed = false;
    let started!: () => void;
    const stalled = new Promise<void>((resolve) => { started = resolve; });
    const server = createServer((request, response) => {
      const shouldStall = !recover && (stage === "head" ? request.method === "HEAD" : request.method === "GET");
      if (shouldStall) {
        response.on("close", () => { closed = true; });
        if (stage === "body") {
          response.writeHead(200, { "Content-Length": "4" });
          response.write("d");
        }
        started();
        return;
      }
      response.writeHead(200, { "Content-Length": "4" });
      response.end(request.method === "HEAD" ? undefined : "data");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const provider = createS3StorageProvider({
      bucket: "test-bucket", region: "us-east-1", forcePathStyle: true,
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    const store = createDurableRunLogStore({ basePath, s3: { provider } });
    const handle = { store: "local_file" as const, logRef: "missing.ndjson" };
    const controller = new AbortController();
    const read = store.read(handle, { signal: controller.signal });
    void read.catch(() => {});
    try {
      await stalled;
      controller.abort();
      await expect(read).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(closed).toBe(true));
      recover = true;
      expect(await store.read(handle)).toEqual({ content: "data", nextOffset: undefined });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(basePath, { recursive: true, force: true });
    }
  }, 10_000);

  it("rejects an already-cancelled local read before opening a file", async () => {
    const store = createDurableRunLogStore({ basePath: os.tmpdir() });
    const controller = new AbortController();
    controller.abort();
    await expect(store.read({ store: "local_file", logRef: "unused.ndjson" }, {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});

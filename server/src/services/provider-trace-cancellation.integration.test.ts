import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, request as forward } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createProviderTraceObjectStore } from "./provider-trace-object-store.js";
import { idleWorkSnapshot } from "./task-admission.js";

const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
afterEach(() => vi.unstubAllEnvs());
describe.skipIf(!endpoint)("trace migration cancellation through the real S3 SDK", () => {
  it.each(["open", "probe", "upload", "restore", "read"])(
    "cancels a stalled %s and releases its capture",
    async (stage) => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "a".repeat(64));
      const bucket = `pc-trace-abort-${randomUUID()}`;
      const directory = await fs.mkdtemp(path.join(tmpdir(), "trace-abort-"));
      const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const ref = `s3-segments-v1:company/run/${randomUUID()}.ndjson`;
      const controller = new AbortController();
      let enabled = true,
        closed = false,
        started!: () => void;
      const stalled = new Promise<void>((resolve) => {
        started = resolve;
      });
      const baseline = idleWorkSnapshot().active;
      const proxy = createServer((request, response) => {
        const url = request.url!;
        const matches =
          stage === "open"
            ? request.method === "GET" && url.includes("head.json")
            : stage === "probe"
              ? request.method === "PUT" && url.includes("conditional-probe-")
              : stage === "upload"
                ? request.method === "PUT" && url.includes("/objects/")
                : request.method === "GET" && url.includes("/objects/");
        if (enabled && matches) {
          response.on("close", () => {
            closed = true;
          });
          started();
          return;
        }
        const upstream = forward(
          new URL(url, endpoint),
          { method: request.method, headers: request.headers },
          (result) => {
            response.writeHead(result.statusCode!, result.headers);
            result.pipe(response);
          },
        );
        response.on("close", () => upstream.destroy());
        upstream.on("error", (error) => response.destroy(error));
        request.pipe(upstream);
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("proxy did not bind");
      const store = createProviderTraceObjectStore(
        createS3StorageProvider({
          endpoint: `http://127.0.0.1:${address.port}`,
          bucket,
          region: "us-east-1",
          forcePathStyle: true,
        }),
      );
      let operation: Promise<unknown> | undefined;
      try {
        const file = path.join(directory, "import.ndjson");
        const body = Buffer.from('{"kind":"frame","rawBase64":"e30="}\n');
        if (stage === "read" || stage === "restore") {
          const seed = createProviderTraceObjectStore(
            createS3StorageProvider({
              endpoint,
              bucket,
              region: "us-east-1",
              forcePathStyle: true,
            }),
          );
          const original = path.join(directory, "original.ndjson");
          await fs.writeFile(original, body);
          await seed.open(ref, original, async () => undefined, { restore: false });
          await seed.finish(ref);
        }
        if (stage === "upload") {
          await fs.writeFile(file, body);
          await store.open(ref, file, async () => undefined, {
            restore: false,
            signal: controller.signal,
          });
          operation = store.finish(ref);
        } else if (stage === "read") operation = store.read(ref, controller.signal);
        else
          operation = store.open(ref, file, async () => undefined, {
            restore: stage === "restore",
            signal: controller.signal,
          });
        const result = operation.then(
          () => "resolved",
          () => "aborted",
        );
        await stalled;
        controller.abort();
        expect(await Promise.race([result, delay(500).then(() => "still running")])).toBe(
          "aborted",
        );
        await vi.waitFor(() => expect(closed).toBe(true));
        expect(idleWorkSnapshot().active).toBe(baseline);
        if (stage === "upload") expect(await fs.readFile(file)).toEqual(body);
      } finally {
        enabled = false;
        controller.abort();
        proxy.closeAllConnections();
        await operation?.catch(() => undefined);
        await store.stopRun("company", "run");
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
        if (objects.Contents?.length)
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects.Contents.map((object) => ({ Key: object.Key! })) },
            }),
          );
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
        client.destroy();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
});

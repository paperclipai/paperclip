import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createS3StorageProvider } from "../src/storage/s3-provider.js";
import { createObjectRunLogStore } from "../src/services/object-run-log-store.js";

const endpoint = process.env.PAPERCLIP_LOG_TEST_S3_ENDPOINT;
if (!endpoint || !["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname)) {
  throw new Error(
    "Qualification requires PAPERCLIP_LOG_TEST_S3_ENDPOINT on a disposable loopback backend",
  );
}
const childMode = process.argv[2] === "--child-writer";
const bucket = childMode ? process.argv[3]! : `paperclip-logs-test-${randomUUID()}`;
const raw = createS3StorageProvider({
  endpoint,
  bucket,
  region: "us-east-1",
  forcePathStyle: true,
});
const counts = { get: 0, put: 0, uploadedBytes: 0 };
const latencies: number[] = [];
const provider = {
  ...raw,
  async getObject(...args: Parameters<typeof raw.getObject>) {
    counts.get++;
    return raw.getObject(...args);
  },
  async putObjectConditional(...args: Parameters<NonNullable<typeof raw.putObjectConditional>>) {
    counts.put++;
    counts.uploadedBytes += args[0].contentLength;
    const start = performance.now();
    try {
      return await raw.putObjectConditional!(...args);
    } finally {
      latencies.push(performance.now() - start);
    }
  },
};
const input = { companyId: "company", agentId: "agent", runId: "crash" };
const options = {
  provider,
  keyPrefix: "qualification",
  flushMs: 1000,
  assertWriterAuthority: async () => undefined,
};
const output = (seq: number) => ({
  stream: "stdout" as const,
  seq,
  chunk: `${seq}: 再開😀 ${"x".repeat(900)}`,
  ts: "2026-10-30T00:00:00Z",
});
if (childMode) {
  const store = createObjectRunLogStore(options),
    handle = await store.begin(input);
  const before = counts.put;
  await Promise.all(Array.from({ length: 1000 }, (_, i) => store.append(handle, output(i + 1))));
  process.stdout.write(
    JSON.stringify({ receipt: true, batchPuts: counts.put - before, counts }) + "\n",
  );
  setTimeout(() => process.exit(2), 30_000);
} else {
  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  const directory = await fs.mkdtemp(path.join(tmpdir(), "run-log-crash-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const started = performance.now();
    child = spawn(
      process.execPath,
      [
        "--import",
        path.resolve("server/node_modules/tsx/dist/loader.mjs"),
        import.meta.filename,
        "--child-writer",
        bucket,
      ],
      { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    let childError = "";
    child.stderr!.on("data", (bytes) => {
      childError = (childError + bytes).slice(-8192);
    });
    const receipt = await new Promise<{ batchPuts: number; counts: typeof counts }>(
      (resolve, reject) => {
        let text = "";
        const timeout = setTimeout(
          () => reject(new Error(`Writer receipt timed out: ${childError}`)),
          30_000,
        );
        child!.stdout!.on("data", (bytes) => {
          text += bytes;
          if (!text.includes("\n")) return;
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(text.split("\n")[0]!));
          } catch (error) {
            reject(error);
          }
        });
        child!.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        void exited.then(() => {
          clearTimeout(timeout);
          if (!text) reject(new Error(`Writer exited before its receipt: ${childError}`));
        });
      },
    );
    child.kill("SIGKILL");
    const [, signal] = await exited;
    if (signal !== "SIGKILL") throw new Error("Writer did not die by SIGKILL");
    await fs.rm(directory, { recursive: true, force: true });
    const successorStore = createObjectRunLogStore(options);
    const successor = await successorStore.begin(input);
    let content = "",
      offset = 0;
    for (;;) {
      const page = await successorStore.read(successor, { offset, limitBytes: 131072 });
      content += page.content;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    const lines = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (
      lines.length !== 1000 ||
      !lines.every((line, i) => line.seq === i + 1 && line.chunk === output(i + 1).chunk)
    )
      throw new Error("Replacement bytes did not match");
    await successorStore.append(successor, output(1001));
    const summary = await successorStore.finalize(successor);

    const steadyBefore = { ...counts },
      steadyStarted = performance.now();
    const steady = createObjectRunLogStore(options);
    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, i) => steady.begin({ ...input, runId: `steady-${i}` })),
    );
    const pending: Promise<number>[] = [];
    for (let tick = 0; tick < 30; tick++) {
      for (const handle of handles) pending.push(steady.append(handle, output(tick + 1)));
      await delay(100);
    }
    await Promise.all(pending);
    await Promise.all(handles.map((handle) => steady.finalize(handle)));
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (objects.IsTruncated) throw new Error("Qualification inventory exceeded one bounded page");
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify(
        {
          backend: "loopback S3-compatible test service",
          flushMs: options.flushMs,
          burst: {
            records: lines.length,
            batchPuts: receipt.batchPuts,
            writerCounts: receipt.counts,
          },
          steady: {
            streams: handles.length,
            records: pending.length,
            elapsedMs: Math.round(performance.now() - steadyStarted),
            putRequests: counts.put - steadyBefore.put,
            getRequests: counts.get - steadyBefore.get,
            uploadedBytes: counts.uploadedBytes - steadyBefore.uploadedBytes,
          },
          readerCounts: counts,
          committedCrashBytes: summary.bytes,
          objects: objects.KeyCount,
          storedBytes: objects.Contents?.reduce((sum, object) => sum + (object.Size ?? 0), 0),
          putP95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)] ?? 0),
          elapsedMs: Math.round(performance.now() - started),
          abruptProcessLoss: signal,
          oldDirectoryRemoved: true,
          replacement: "passed",
        },
        null,
        2,
      ),
    );
  } finally {
    child?.kill("SIGKILL");
    await fs.rm(directory, { recursive: true, force: true });
    for (;;) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
      if (!page.Contents?.length) break;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: page.Contents.map((object) => ({ Key: object.Key! })) },
        }),
      );
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  }
}

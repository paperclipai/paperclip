import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import { createS3StorageProvider } from "../../storage/s3-provider.js";
import { HistoryPayloadStore } from "./history-payload-store.js";
import { createSegmentedRunLogStore } from "../segmented-run-log-store.js";
import type { StorageProvider } from "../../storage/types.js";

const execute = promisify(execFile);
it.skipIf(process.env.PAPERCLIP_HISTORY_S3_QUALIFICATION !== "1")("publishes verified immutable history through a real S3-compatible object server", async () => {
  const owner = randomUUID(), name = `paperclip-history-s3-${owner}`;
  const accessKeyId = "history-qualification", secretAccessKey = randomBytes(32).toString("hex");
  const env = { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey };
  const docker = async (args: string[]) => (await execute("docker", args, { env, maxBuffer: 128 * 1024, timeout: 30_000 })).stdout.trim();
  const image = await docker(["image", "inspect", "minio/minio:latest", "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("S3 qualification requires an installed immutable image ID");
  const started = Date.now();
  let client: S3Client | undefined, created = false;
  let evidence: Record<string, unknown> | undefined;
  let basePath: string | undefined;
  try {
    // No host mounts, published non-loopback ports, persistent volumes or real
    // cloud credentials. Record intent before create so ambiguous replies clean up.
    created = true;
    await docker(["create", "--name", name, "--label", `paperclip.history-qualification=${owner}`,
      "--publish", "127.0.0.1::9000", "--tmpfs", "/data:rw,size=512m", "--env", "MINIO_ROOT_USER", "--env", "MINIO_ROOT_PASSWORD",
      image, "server", "/data", "--address", ":9000"]);
    await docker(["start", name]);
    const inspected = JSON.parse(await docker(["inspect", name]))[0];
    const port = inspected.NetworkSettings.Ports["9000/tcp"]?.[0];
    if (inspected.Config.Labels["paperclip.history-qualification"] !== owner || port?.HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(port.HostPort)) throw new Error("S3 fixture ownership or port mismatch");
    const endpoint = `http://127.0.0.1:${port.HostPort}`;
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (await fetch(`${endpoint}/minio/health/live`).then(r => r.ok, () => false)) break;
      if (Date.now() >= deadline) throw new Error("S3 fixture readiness timeout");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    vi.stubEnv("AWS_ACCESS_KEY_ID", accessKeyId);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", secretAccessKey);
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    const bucket = `history-${owner}`;
    client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const config = { endpoint, bucket, region: "us-east-1", forcePathStyle: true, prefix: "qualification" };
    const provider = createS3StorageProvider(config), store = new HistoryPayloadStore(provider);
    const scope = { companyId: randomUUID(), runId: randomUUID() }, bytes = randomBytes(1024 * 1024);
    const ref = await store.put(scope, bytes, "application/json");
    expect(await store.put(scope, bytes, "application/json")).toEqual(ref);
    const reopened = new HistoryPayloadStore(createS3StorageProvider(config));
    expect(await reopened.read(scope, ref, bytes.length)).toEqual(bytes);
    await expect(reopened.read({ ...scope, companyId: randomUUID() }, ref, bytes.length)).rejects.toThrow("reference_invalid");
    await provider.deleteObject({ objectKey: ref.objectKey });
    await expect(reopened.read(scope, ref, bytes.length)).rejects.toThrow("not found");
    basePath = await mkdtemp(join(tmpdir(), "paperclip-segmented-s3-"));
    const reads: string[] = [], uploads: Array<{ key: string; bytes: number }> = [];
    const observed: StorageProvider = {
      id: "s3",
      async getObject(input) { reads.push(input.objectKey); return provider.getObject(input); },
      async putObject(input) { uploads.push({ key: input.objectKey, bytes: input.contentLength }); return provider.putObject(input); },
      async putObjectConditional(input, expected) { uploads.push({ key: input.objectKey, bytes: input.contentLength }); return provider.putObjectConditional!(input, expected); },
      headObject: provider.headObject, deleteObject: provider.deleteObject,
    };
    const binding = { companyId: scope.companyId, agentId: randomUUID(), runId: randomUUID() };
    let log = createSegmentedRunLogStore({ basePath, s3: { provider: observed } });
    const handle = await log.begin(binding), expected = createHash("sha256");
    let totalBytes = 0;
    for (let index = 0; index < 18; index++) {
      const event = { stream: "stdout" as const, ts: `2026-09-28T00:00:${String(index).padStart(2,"0")}Z`, chunk: randomBytes(3 * 1024 * 1024).toString("base64") };
      expected.update(JSON.stringify(event) + "\n"); totalBytes += await log.append(handle, event);
    }
    await log.flushInflightMirrors!();
    expect(totalBytes).toBeGreaterThan(64 * 1024 * 1024);
    const completedUploads = uploads.filter(value => /\/segments\/.*\.ndjson\.[a-f0-9]{64}$/.test(value.key));
    expect(completedUploads.length).toBe(2);
    expect(new Set(completedUploads.map(value => value.key)).size).toBe(2);
    await rm(basePath, { recursive: true });
    reads.length = 0;
    log = createSegmentedRunLogStore({ basePath, s3: { provider: observed } });
    await log.begin(binding);
    expect(reads.some(key => key.includes("/segments/"))).toBe(false);
    const headBytes = (await stat(join(basePath, handle.logRef, "head.json"))).size;
    expect(headBytes).toBeLessThan(1024);
    const resumed = { stream: "stdout" as const, ts: "resumed", chunk: "continued after losing the local volume" };
    expected.update(JSON.stringify(resumed) + "\n"); totalBytes += await log.append(handle, resumed);
    await log.flushInflightMirrors!();
    const actual = createHash("sha256"); let cursor = "0";
    do {
      const page = await log.read(handle, { cursor, limitBytes: 1024 * 1024 });
      actual.update(page.content); cursor = page.cursor!;
      if (!page.hasMore) break;
    } while (true);
    expect(cursor).toBe(String(totalBytes));
    const digest = actual.digest("hex"); expect(digest).toBe(expected.digest("hex"));
    const oldKey = completedUploads[0]!.key, corrupt = Buffer.alloc(32 * 1024 * 1024, "!");
    await provider.putObject({ objectKey: oldKey, body: corrupt, contentType: "application/x-ndjson", contentLength: corrupt.length, sha256: createHash("sha256").update(corrupt).digest("hex") });
    await expect(createSegmentedRunLogStore({ basePath, s3: { provider: observed } }).read(handle, { limitBytes: 64 })).rejects.toThrow("segment_digest_mismatch");
    await provider.deleteObject({ objectKey: oldKey });
    // An unavailable archived segment prevents its historical read, but must
    // not prevent reopening, appending or finalizing current work.
    log = createSegmentedRunLogStore({ basePath, s3: { provider: observed } });
    await log.begin(binding);
    const final = { stream: "stdout" as const, ts: "final", chunk: "current work remains available" };
    const beforeFinal = totalBytes; totalBytes += await log.append(handle, final);
    expect((await log.finalize(handle)).bytesExact).toBe(String(totalBytes));
    expect((await log.read(handle, { cursor: String(beforeFinal) })).content).toBe(JSON.stringify(final) + "\n");
    await expect(log.read(handle, { limitBytes: 64 })).rejects.toThrow("not found");

    // Exercise the actual S3 conditional write, including immutable tails:
    // an old upload is paused while a replacement claims and publishes.
    let reached!: () => void, release!: () => void, armed = false;
    const blocked = new Promise<void>(resolve => { reached = resolve; });
    const resumedUpload = new Promise<void>(resolve => { release = resolve; });
    const old = createSegmentedRunLogStore({ basePath: join(basePath, "old-owner"), segmentBytes: 1024, s3: { provider },
      onBoundary: async boundary => { if (armed && boundary === "remote-tail") { armed = false; reached(); await resumedUpload; } } });
    const raceBinding = { ...binding, runId: randomUUID() }, raceHandle = await old.begin(raceBinding);
    const initial = { stream: "stdout" as const, ts: "initial", chunk: "before replacement" };
    const continuation = { stream: "stdout" as const, ts: "next", chunk: "replacement output" };
    await old.append(raceHandle, initial); await old.flushInflightMirrors!();
    await old.append(raceHandle, { ...initial, chunk: "late old output" }); armed = true;
    const late = old.flushInflightMirrors!(); void late.catch(() => {});
    try {
      await blocked;
      const replacement = createSegmentedRunLogStore({ basePath: join(basePath, "replacement-owner"), s3: { provider } });
      await replacement.begin(raceBinding); await replacement.append(raceHandle, continuation); await replacement.flushInflightMirrors!();
      release(); await expect(late).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
      const reader = createSegmentedRunLogStore({ basePath: join(basePath, "independent-reader"), s3: { provider } });
      expect((await reader.read(raceHandle)).content).toBe([initial, continuation].map(value => JSON.stringify(value) + "\n").join(""));
    } finally { release(); await late.catch(() => {}); }
    evidence = { image, backend: "local MinIO S3-compatible API; not hosted AWS", bytes: bytes.length,
      sha256: ref.sha256, uploadVerified: true, reopenedReadVerified: true, tenantRejected: true, missingObjectRejected: true,
      segmentedLog: { totalBytes, verifiedHistorySha256: digest, headBytes, completedSegments: completedUploads.length,
        fullStreamVerified: true, volumeLossRestored: true, reopenFetchedHistoricalSegments: false, corruptionRejected: true, missingHistoryDoesNotBlockCurrentWork: true,
        conditionalOwnerReplacementVerified: true, lateWriterRejected: true } };
  } finally {
    client?.destroy();
    vi.unstubAllEnvs();
    if (basePath) await rm(basePath, { recursive: true, force: true });
    if (created) {
      const found = await docker(["inspect", name]).then(value => JSON.parse(value)[0], () => null);
      if (found) {
        if (found.Config.Labels["paperclip.history-qualification"] !== owner) throw new Error("S3 fixture cleanup owner mismatch");
        await docker(["rm", "--force", "--volumes", found.Id]);
      }
    }
  }
  if (process.env.PAPERCLIP_HISTORY_REPORT) await writeFile(process.env.PAPERCLIP_HISTORY_REPORT,
    JSON.stringify({ ...evidence, status: "passed", cleanupVerified: true, elapsedMs: Date.now() - started }, null, 2), { mode: 0o600 });
}, 180_000);

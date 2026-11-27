import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minioBinary, startMinio, type ObjectStore } from "./object-store.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { auditsStorage, checkCommittedSnapshots, listIncompleteUploads, storageAuditFailures, storedKey, unexercisedFaults } from "./storage-audit.js";
import { planStorageFaults, storageFaultRules } from "./storage-chaos.js";
import { LAG_MS_RANGE, ReadAfterWriteTracker, lagFaultRules } from "./storage-lag.js";
import { SNAPSHOT_PATH, multipartFaultRules } from "./storage-multipart.js";
import { startStorageFaultProxy } from "./storage-proxy.js";
import { partNumberOf, s3Operation } from "./storage-s3-ops.js";

const binary = minioBinary();
const sdk = createRequire(new URL("../../server/package.json", import.meta.url))("@aws-sdk/client-s3");
const MIB = 1024 * 1024;

function seeded(values: number[]) {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe("S3 operation classification", () => {
  it("names multipart, object and bucket operations from method and query", () => {
    const key = "/b/chaos/w/c/workspace-snapshots/ws/s/u.pcws";
    expect(s3Operation("POST", `${key}?uploads=&x-id=CreateMultipartUpload`)).toBe("CreateMultipartUpload");
    expect(s3Operation("PUT", `${key}?partNumber=3&uploadId=abc&x-id=UploadPart`)).toBe("UploadPart");
    expect(partNumberOf(`${key}?partNumber=3&uploadId=abc`)).toBe(3);
    expect(s3Operation("POST", `${key}?uploadId=abc`)).toBe("CompleteMultipartUpload");
    expect(s3Operation("DELETE", `${key}?uploadId=abc`)).toBe("AbortMultipartUpload");
    expect(s3Operation("GET", "/b?uploads=&prefix=chaos")).toBe("ListMultipartUploads");
    expect(s3Operation("PUT", key)).toBe("PutObject");
    expect(s3Operation("GET", `${key}?x-id=GetObject`)).toBe("GetObject");
    expect(s3Operation("HEAD", key)).toBe("HeadObject");
    expect(s3Operation("GET", "/b?list-type=2&prefix=x")).toBe("ListObjects");
    expect(s3Operation("POST", "/b?delete=")).toBe("DeleteObjects");
  });
});

describe("ST4 and ST7 planning", () => {
  it("plans ST4 as seeded faults on snapshot upload parts and sometimes on the completion", () => {
    const rules = multipartFaultRules(seeded([0.1, 0.9, 0.1, 0.9, 0.2, 0.0, 0.4, 0.1, 0.0, 0.0, 0.0, 0.7]));
    expect(rules).toEqual([
      { fault: { kind: "errors", rate: 1, status: 500 }, operations: ["UploadPart"], partNumbers: [1, 3], pathIncludes: SNAPSHOT_PATH, remaining: 1 },
      { fault: { kind: "errors", rate: 1, status: 500 }, operations: ["CompleteMultipartUpload"], pathIncludes: SNAPSHOT_PATH, remaining: 2 },
    ]);
    const kinds = new Set<string>();
    for (let seed = 1; seed < 200; seed += 1) {
      for (const window of planStorageFaults({ kinds: ["ST4"], seed, spanMs: 100_000 })) {
        for (const rule of window.rules) { kinds.add(`${rule.operations?.join()}:${rule.fault.kind}`); expect(rule.pathIncludes).toBe(SNAPSHOT_PATH); }
      }
    }
    expect([...kinds].sort()).toEqual(["CompleteMultipartUpload:errors", "CompleteMultipartUpload:reset", "UploadPart:errors", "UploadPart:reset", "UploadPart:truncate"]);
  });

  it("plans ST7 as a seeded read-after-write lag on object reads", () => {
    expect(lagFaultRules(() => 0.5)).toEqual([{ fault: { kind: "read_after_write_lag", lagMs: 17_500 }, methods: ["GET", "HEAD"], operations: ["GetObject", "HeadObject"] }]);
    const [rule] = storageFaultRules("ST7", () => 1);
    expect(rule!.fault).toEqual({ kind: "read_after_write_lag", lagMs: LAG_MS_RANGE[1] });
  });

  it("plans ST8 as a seeded SlowDown run on provider-session backup uploads, longer than one request's retries", async () => {
    expect(storageFaultRules("ST8", () => 0)).toEqual([{ fault: { kind: "throttle" }, methods: ["PUT"],
      pathIncludes: "native-harness-backups", firstObjectOnly: true, remaining: 9 }]);
    expect(storageFaultRules("ST8", () => 0.99)[0]!.remaining).toBe(12);
    expect(unexercisedFaults(["ST8"], { "PutObject:outage": 1 })).toEqual(["ST8"]);
    expect(unexercisedFaults(["ST8"], { "PutObject:errors": 9, "UploadPart:errors": 2 })).toEqual(["ST8"]);
    expect(unexercisedFaults(["ST8"], { "PutObject:throttle": 9 })).toEqual([]);
    expect(auditsStorage({ storage: "s3", storageFaults: ["ST8"] })).toBe(true);
    let received = 0;
    const server = createServer((incoming, outgoing) => { received += 1; incoming.resume(); outgoing.writeHead(200).end(); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const proxy = await startStorageFaultProxy(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
      proxy.setRules(storageFaultRules("ST8", () => 0));
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        statuses.push((await fetch(`${proxy.endpoint}/b/c/native-harness-backups/s/id.pchn`, { method: "PUT", body: "x" })).status);
        if (attempt === 0) {
          expect((await fetch(`${proxy.endpoint}/b/c/native-harness-backups/s/other.pchn`, { method: "PUT", body: "x" })).status).toBe(200);
        }
      }
      expect((await fetch(`${proxy.endpoint}/b/c/workspace-snapshots/k`, { method: "PUT", body: "x" })).status).toBe(200);
      expect(statuses).toEqual([...Array(9).fill(503), 200]);
      expect(received).toBe(3);
      expect(proxy.counts().injectedBy).toEqual({ "PutObject:throttle": 9 });
    } finally {
      await proxy.close();
      server.closeAllConnections(); server.close();
    }
  });

  it("audits storage only on s3 waves that plan or replay ST4 or ST7", () => {
    expect(auditsStorage({ storage: "s3", storageFaults: ["ST4"] })).toBe(true);
    expect(auditsStorage({ storage: "s3", storageWindows: [{ kind: "ST7" }] })).toBe(true);
    expect(auditsStorage({ storage: "s3", storageFaults: ["ST1"] })).toBe(false);
    expect(auditsStorage({ storageFaults: ["ST4"] })).toBe(false);
  });

  it("names each planned ST4 or ST7 fault that never changed a request", () => {
    expect(unexercisedFaults(["ST4", "ST7", "ST4", "ST1"], { "PutObject:outage": 3 })).toEqual(["ST4", "ST7"]);
    expect(unexercisedFaults(["ST4", "ST7"], { "UploadPart:truncate": 1, "HeadObject:read_after_write_lag": 2 })).toEqual([]);
    expect(unexercisedFaults(["ST4"], { "CompleteMultipartUpload:errors": 1 })).toEqual([]);
  });

  it("forwards a truncated part's first bytes to the store before it cuts both connections", async () => {
    let received = 0;
    let closed!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer(incoming => {
      incoming.on("data", (chunk: Buffer) => { received += chunk.length; });
      incoming.on("close", () => closed());
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const proxy = await startStorageFaultProxy(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
      proxy.setRules([{ fault: { kind: "truncate", afterBytes: MIB }, operations: ["UploadPart"] }]);
      await expect(fetch(`${proxy.endpoint}/b/k?partNumber=1&uploadId=u`, { method: "PUT", body: Buffer.alloc(4 * MIB) })).rejects.toThrow();
      await upstreamClosed;
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(4 * MIB);
      expect(proxy.counts()).toMatchObject({ injected: 1, injectedBy: { "UploadPart:truncate": 1 } });
    } finally {
      await proxy.close();
      server.closeAllConnections(); server.close();
    }
  });

  it("passes a part shorter than the truncation point through untouched", async () => {
    let received = 0;
    const server = createServer((incoming, outgoing) => {
      incoming.on("data", (chunk: Buffer) => { received += chunk.length; });
      incoming.on("end", () => outgoing.writeHead(200, { etag: "\"p\"" }).end());
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const proxy = await startStorageFaultProxy(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
      proxy.setRules([{ fault: { kind: "truncate", afterBytes: MIB }, operations: ["UploadPart"] }]);
      const response = await fetch(`${proxy.endpoint}/b/k?partNumber=9&uploadId=u`, { method: "PUT", body: Buffer.alloc(1024) });
      expect([response.status, received]).toEqual([200, 1024]);
      expect(proxy.counts()).toMatchObject({ injected: 0, injectedBy: {} });
    } finally {
      await proxy.close();
      server.closeAllConnections(); server.close();
    }
  });

  it("lags reads of a key only after a successful object write and only for the lag", () => {
    let now = 1_000;
    const tracker = new ReadAfterWriteTracker(() => now);
    tracker.note("PUT", "/b/k?partNumber=1&uploadId=u", 200);
    tracker.note("PUT", "/b/failed", 503);
    expect(tracker.lagging("/b/k", 5_000)).toBe(false);
    expect(tracker.lagging("/b/failed", 5_000)).toBe(false);
    tracker.note("POST", "/b/k?uploadId=u", 200);
    tracker.note("PUT", "/b/a%20b", 200);
    now += 4_000;
    expect(tracker.lagging("/b/k?x-id=GetObject", 5_000)).toBe(true);
    expect(tracker.lagging("/b/a b", 5_000)).toBe(true);
    now += 1_000;
    expect(tracker.lagging("/b/k", 5_000)).toBe(false);
    expect(tracker.lagged).toBe(2);
  });

  it("reports orphaned uploads and unrestorable committed snapshots as wave failures", () => {
    expect(storageAuditFailures({ incompleteUploads: [{ key: "k", uploadId: "u", initiated: null }], committedSnapshots: 1,
      snapshotProblems: [{ id: "s", objectKey: "c/k", problem: "object_missing" }], snapshotsChecked: true, unexercisedFaults: [], errors: [] }))
      .toEqual(["orphaned multipart upload k (u, initiated unknown)", "committed snapshot s does not restore: object_missing"]);
    expect(storageAuditFailures({ incompleteUploads: [], committedSnapshots: 0, snapshotProblems: [], snapshotsChecked: false,
      unexercisedFaults: ["ST4"], errors: [] })).toEqual(["storage fault ST4 never changed a request: the wave did not test it",
      "storage audit incomplete: committed snapshots were not checked"]);
    expect(storedKey("chaos/w1/", "c/workspace-snapshots/x")).toBe("chaos/w1/c/workspace-snapshots/x");
  });
});

describe.skipIf(!binary)("ST4 and ST7 against MinIO", () => {
  let root: string;
  let store: ObjectStore;
  let now = 0;
  const tracker = new ReadAfterWriteTracker(() => now);
  let proxy: Awaited<ReturnType<typeof startStorageFaultProxy>>;
  let client: InstanceType<typeof sdk.S3Client>;
  const key = `chaos/w1/c/${SNAPSHOT_PATH}/ws/s/u.pcws`;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-st4-"));
    store = await startMinio({ binary: binary!, root });
    proxy = await startStorageFaultProxy(store.endpoint, Math.random, tracker);
    client = new sdk.S3Client({ endpoint: proxy.endpoint, region: store.region, forcePathStyle: true, maxAttempts: 1,
      credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey } });
  }, 60_000);
  afterAll(async () => {
    client?.destroy();
    await proxy?.close();
    await store?.stop();
    await rm(root, { recursive: true, force: true });
  });

  const part = (uploadId: string, number: number, bytes = 5 * MIB) => client.send(new sdk.UploadPartCommand({
    Bucket: store.bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: Buffer.alloc(bytes, number) }));

  it("fails the chosen upload parts, cuts a part body mid-transfer, fails the completion, and finds the orphaned upload", async () => {
    const { UploadId: uploadId } = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket: store.bucket, Key: key }));
    proxy.setRules([{ fault: { kind: "errors", rate: 1, status: 500 }, operations: ["UploadPart"], partNumbers: [2], pathIncludes: SNAPSHOT_PATH, remaining: 1 }]);
    const first = await part(uploadId, 1);
    await expect(part(uploadId, 2)).rejects.toMatchObject({ $metadata: { httpStatusCode: 500 } });
    const second = await part(uploadId, 2);
    proxy.setRules([{ fault: { kind: "truncate", afterBytes: MIB }, operations: ["UploadPart"], pathIncludes: SNAPSHOT_PATH, remaining: 1 }]);
    await expect(part(uploadId, 3, 2 * MIB)).rejects.toThrow();
    const third = await part(uploadId, 3, 2 * MIB);
    expect(await listIncompleteUploads(store, "chaos/w1/")).toEqual([{ key, uploadId, initiated: expect.any(String) }]);
    proxy.setRules([{ fault: { kind: "errors", rate: 1, status: 500 }, operations: ["CompleteMultipartUpload"], pathIncludes: SNAPSHOT_PATH, remaining: 1 }]);
    const complete = () => client.send(new sdk.CompleteMultipartUploadCommand({ Bucket: store.bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: [first, second, third].map((result, index) => ({ ETag: result.ETag, PartNumber: index + 1 })) } }));
    await expect(complete()).rejects.toMatchObject({ $metadata: { httpStatusCode: 500 } });
    expect(await listIncompleteUploads(store, "chaos/w1/")).toHaveLength(1);
    proxy.clear();
    await complete();
    expect(tracker.lagging(`/${store.bucket}/${key}`, 1)).toBe(true);
    expect(await listIncompleteUploads(store, "chaos/w1/")).toEqual([]);
    expect(proxy.counts()).toMatchObject({ injected: 3, byStatus: { 500: 2, reset: 1 },
      injectedBy: { "UploadPart:errors": 1, "UploadPart:truncate": 1, "CompleteMultipartUpload:errors": 1 } });
  }, 60_000);

  it("answers NoSuchKey to reads of a just-written object until the lag passes, and verifies committed snapshots", async () => {
    now = 10_000;
    const body = Buffer.from("snapshot bytes");
    const written = `chaos/w1/c/${SNAPSHOT_PATH}/ws/s2/v.pcws`;
    proxy.setRules(lagFaultRules(() => 0));
    await client.send(new sdk.PutObjectCommand({ Bucket: store.bucket, Key: written, Body: body }));
    now += LAG_MS_RANGE[0] - 1;
    await expect(client.send(new sdk.GetObjectCommand({ Bucket: store.bucket, Key: written }))).rejects.toMatchObject({ name: "NoSuchKey" });
    await expect(client.send(new sdk.HeadObjectCommand({ Bucket: store.bucket, Key: written }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    now += 1;
    const read = await client.send(new sdk.GetObjectCommand({ Bucket: store.bucket, Key: written }));
    expect(Buffer.from(await read.Body.transformToByteArray()).toString()).toBe("snapshot bytes");
    proxy.clear();
    const sha256 = createHash("sha256").update(body).digest("hex");
    expect(await checkCommittedSnapshots(store, "chaos/w1/", [
      { id: "good", objectKey: `c/${SNAPSHOT_PATH}/ws/s2/v.pcws`, sha256, byteSize: body.length },
      { id: "corrupt", objectKey: `c/${SNAPSHOT_PATH}/ws/s2/v.pcws`, sha256: "0".repeat(64), byteSize: body.length },
      { id: "missing", objectKey: `c/${SNAPSHOT_PATH}/ws/s3/none.pcws`, sha256, byteSize: body.length },
    ])).toEqual([
      { id: "corrupt", objectKey: `c/${SNAPSHOT_PATH}/ws/s2/v.pcws`, problem: "sha256_mismatch" },
      { id: "missing", objectKey: `c/${SNAPSHOT_PATH}/ws/s3/none.pcws`, problem: "object_missing" },
    ]);
  }, 60_000);
});

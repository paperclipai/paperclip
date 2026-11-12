/**
 * Measures what saving and restoring one workspace snapshot costs the server's
 * main thread, and how long an unrelated request waits meanwhile.
 *
 * Three processes, so a blocked server thread cannot hide its own stall:
 *
 *   server  runs the real `uploadWorkspaceSnapshot` and
 *           `loadWorkspaceSnapshotArchive` against the real S3 provider, and
 *           answers a trivial `GET /` on the same thread.
 *   store   an S3-compatible object store on loopback that checks every part's
 *           Content-MD5, as the hosted backend does.
 *   probe   requests `GET /` from the server one after another and times each
 *           reply with its own clock.
 *
 * The archive is synthetic random bytes: the storage layer treats it as opaque.
 *
 *   pnpm --filter @paperclipai/server exec tsx scripts/benchmark-workspace-snapshot-crypto.ts --mib=200
 *   pnpm --filter @paperclipai/server exec tsx scripts/benchmark-workspace-snapshot-crypto.ts --mib=1024
 *
 * Options: --mib=<archive size, default 200>, --samples=<default 1>,
 * --no-load (skip the restore). To compare two revisions, run the same script
 * from a checkout of each. Results vary with machine load: report it.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Agent, createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const option = (name: string, fallback: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const role = option("role", "run");
const MIB = 1024 * 1024;
const round = (value: number) => Math.round(value * 10) / 10;
const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});
const message = <T>(child: ChildProcess | NodeJS.Process, kind: string) => new Promise<T>((resolve, reject) => {
  const onMessage = (value: { kind: string }) => {
    if (value.kind === "failed") { child.off("message", onMessage); reject(new Error((value as unknown as { error: string }).error)); }
    if (value.kind !== kind) return;
    child.off("message", onMessage); resolve(value as T);
  };
  child.on("message", onMessage);
});

type Phase = "idle" | "upload" | "load";
type PhaseResult = {
  wallMs: number; mainThreadBusyMs: number; mainThreadCpuMs: number | null; processCpuMs: number;
  eventLoopDelayMaxMs: number; eventLoopDelayP99Ms: number; peakRssMib: number; steps: Record<string, number | undefined>;
};
type ProbeResult = Record<Phase, { requests: number; p50Ms: number; p99Ms: number; maxMs: number; over20Ms: number; over100Ms: number }>;

if (role === "store") await store();
else if (role === "probe") await probe();
else if (role === "server") await server();
else await run();

/** S3-compatible store: multipart uploads with Content-MD5 checks, HEAD, ranged GET and DELETE. */
async function store() {
  const root = option("root", "");
  const objects = new Map<string, { parts: Array<{ file: string; size: number }>; size: number; etag: string }>();
  const uploads = new Map<string, Map<number, { file: string; size: number; etag: string }>>();
  const receive = async (request: IncomingMessage, file: string) => {
    const digest = createHash("md5"); let size = 0;
    const output = createWriteStream(file);
    request.on("data", (chunk: Buffer) => { digest.update(chunk); size += chunk.length; });
    await pipeline(request, output);
    return { size, md5: digest.digest() };
  };
  const text = async (request: IncomingMessage) => { let body = ""; for await (const chunk of request) body += chunk; return body; };
  const reject = (response: ServerResponse, status: number, code: string) => response.writeHead(status, { "content-type": "application/xml" })
    .end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, "http://store"), key = url.pathname, uploadId = url.searchParams.get("uploadId");
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = randomUUID(); uploads.set(id, new Map());
      response.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); return;
    }
    if (request.method === "PUT") {
      const number = Number(url.searchParams.get("partNumber") ?? 1), file = path.join(root, `${randomUUID()}.part`);
      const received = await receive(request, file), expected = request.headers["content-md5"];
      if (!expected || received.md5.toString("base64") !== expected || received.size !== Number(request.headers["content-length"])) {
        await fs.rm(file, { force: true }); reject(response, 400, "BadDigest"); return;
      }
      const etag = `"${received.md5.toString("hex")}"`;
      if (uploadId) uploads.get(uploadId)!.set(number, { file, size: received.size, etag });
      else objects.set(key, { parts: [{ file, size: received.size }], size: received.size, etag });
      response.writeHead(200, { etag }).end(); return;
    }
    if (request.method === "POST" && uploadId) {
      const body = await text(request), saved = uploads.get(uploadId)!;
      const numbers = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(match => Number(match[1]));
      const parts = numbers.map(number => saved.get(number)!);
      if (parts.some(part => !part) || numbers.length !== saved.size) { reject(response, 400, "InvalidPart"); return; }
      uploads.delete(uploadId);
      objects.set(key, { parts, size: parts.reduce((total, part) => total + part.size, 0), etag: `"${uploadId}"` });
      response.end("<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>"); return;
    }
    if (request.method === "DELETE") {
      for (const part of [...(uploadId ? uploads.get(uploadId)?.values() ?? [] : []), ...(uploadId ? [] : objects.get(key)?.parts ?? [])]) await fs.rm(part.file, { force: true });
      if (uploadId) uploads.delete(uploadId); else objects.delete(key);
      response.writeHead(204).end(); return;
    }
    const object = objects.get(key);
    if (!object) { reject(response, 404, request.method === "HEAD" ? "NotFound" : "NoSuchKey"); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0, end = range ? Math.min(Number(range[2]), object.size - 1) : object.size - 1;
    const headers = { "content-length": String(end - start + 1), etag: object.etag, "last-modified": new Date().toUTCString(),
      ...(range ? { "content-range": `bytes ${start}-${end}/${object.size}` } : {}) };
    response.writeHead(range ? 206 : 200, headers); response.setMaxListeners(0);
    if (request.method === "HEAD") { response.end(); return; }
    let offset = 0;
    for (const part of object.parts) {
      const from = Math.max(start, offset), to = Math.min(end, offset + part.size - 1);
      if (from <= to) await pipeline(createReadStream(part.file, { start: from - offset, end: to - offset }), response, { end: false });
      offset += part.size;
    }
    response.end();
  };
  const http = createServer((request, response) => { handle(request, response).catch(() => response.destroy()); });
  process.send!({ kind: "ready", port: await listen(http) });
  process.on("message", () => { http.closeAllConnections(); http.close(() => process.disconnect()); });
}

/** Sequential trivial requests to the server, bucketed by the phase the server reports. */
async function probe() {
  const port = Number(option("port", "0")), agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const samples: Record<Phase, number[]> = { idle: [], upload: [], load: [] };
  let active = true;
  process.on("message", () => { active = false; });
  process.send!({ kind: "ready" });
  while (active) {
    const started = performance.now();
    const phase = await new Promise<Phase | null>(resolve => {
      const request = get({ host: "127.0.0.1", port, agent, path: "/" }, response => {
        response.resume(); response.once("end", () => resolve(response.headers["x-phase"] as Phase));
      });
      request.once("error", () => resolve(null));
    });
    if (phase) samples[phase].push(performance.now() - started);
    await delay(2);
  }
  agent.destroy();
  const summary = Object.fromEntries(Object.entries(samples).map(([phase, values]) => {
    const sorted = values.sort((a, b) => a - b);
    return [phase, { requests: sorted.length, p50Ms: round(percentile(sorted, 0.5)), p99Ms: round(percentile(sorted, 0.99)),
      maxMs: round(sorted.at(-1) ?? 0), over20Ms: sorted.filter(value => value > 20).length, over100Ms: sorted.filter(value => value > 100).length }];
  }));
  process.send!({ kind: "result", summary });
  process.disconnect();
}

/** The process under measurement. */
async function server() {
  const root = option("root", ""), archivePath = option("archive", ""), restore = option("load", "1") === "1";
  process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("hex");
  process.env.AWS_ACCESS_KEY_ID = "benchmark"; process.env.AWS_SECRET_ACCESS_KEY = "benchmark"; process.env.AWS_SESSION_TOKEN = "";
  const { createDb, closeRegisteredClients } = await import("../../packages/db/src/index.js");
  const { createS3StorageProvider } = await import("../src/storage/s3-provider.js");
  const { createStorageService } = await import("../src/storage/service.js");
  const snapshots = await import("../src/services/remote-workspace-snapshot-storage.js");
  const databaseUrl = option("database", ""), db = createDb(databaseUrl);
  const storage = createStorageService(createS3StorageProvider({ bucket: "bucket", region: "us-east-1", forcePathStyle: true,
    endpoint: `http://127.0.0.1:${option("store", "0")}` }));
  let phase: Phase = "idle";
  const http = createServer((_request, response) => { response.setHeader("x-phase", phase); response.end("ok"); });
  const histogram = monitorEventLoopDelay({ resolution: 1 }); histogram.enable();
  const threadCpu = (process as unknown as { threadCpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage }).threadCpuUsage?.bind(process);
  const measure = async (name: Exclude<Phase, "idle">, work: (timing: ReturnType<typeof snapshots.newWorkspaceSnapshotStorageTiming>) => Promise<unknown>): Promise<PhaseResult> => {
    const timing = snapshots.newWorkspaceSnapshotStorageTiming();
    let peakRss = process.memoryUsage.rss();
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); }, 10);
    await delay(50); histogram.reset();
    const utilization = performance.eventLoopUtilization(), cpu = process.cpuUsage(), thread = threadCpu?.(), started = performance.now();
    phase = name;
    try { await work(timing); }
    finally { phase = "idle"; }
    const wallMs = performance.now() - started, busy = performance.eventLoopUtilization(utilization);
    const used = process.cpuUsage(cpu), main = thread ? threadCpu!(thread) : null;
    clearInterval(sampler);
    const { requests: _requests, ...steps } = timing;
    return { wallMs: round(wallMs), mainThreadBusyMs: round(busy.active), mainThreadCpuMs: main ? round((main.user + main.system) / 1000) : null,
      processCpuMs: round((used.user + used.system) / 1000), eventLoopDelayMaxMs: round(histogram.max / 1e6),
      eventLoopDelayP99Ms: round(histogram.percentile(99) / 1e6), peakRssMib: round(peakRss / MIB), steps };
  };
  const save = async (file: string, timing?: ReturnType<typeof snapshots.newWorkspaceSnapshotStorageTiming>) => {
    const companyId = randomUUID(), workspaceId = randomUUID();
    const row = await snapshots.beginWorkspaceSnapshot(db, { companyId, workspaceId, operationId: randomUUID(), generation: 1, epoch: 0 });
    return snapshots.uploadWorkspaceSnapshot({ db, storage, snapshotId: row.id, companyId, workspaceId, archivePath: file,
      manifestDigest: "ab".repeat(32), timing });
  };
  const sha256 = async (file: string) => {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file, { highWaterMark: MIB })) digest.update(chunk);
    return digest.digest("hex");
  };
  process.send!({ kind: "ready", port: await listen(http) });
  process.on("message", async (request: { kind: string }) => {
    try {
      if (request.kind === "close") {
        await closeRegisteredClients(databaseUrl);
        http.closeAllConnections(); http.close(() => process.disconnect());
        return;
      }
      // One small save and restore first, so module loading, the database
      // connection and the storage client are not counted.
      const warm = path.join(root, "warm.pcws"); await fs.writeFile(warm, randomBytes(4 * MIB));
      await snapshots.loadWorkspaceSnapshotArchive({ storage, reference: await save(warm), targetPath: path.join(root, `warm-${randomUUID()}.out`) });
      let reference!: Awaited<ReturnType<typeof save>>;
      const upload = await measure("upload", async timing => { reference = await save(archivePath, timing); });
      const restored = path.join(root, `restored-${randomUUID()}.pcws`);
      const load = restore ? await measure("load", timing => snapshots.loadWorkspaceSnapshotArchive({ storage, reference, targetPath: restored, timing })) : null;
      if (restore) { assert.equal(await sha256(restored), await sha256(archivePath), "restored archive differs from the saved one"); await fs.rm(restored); }
      process.send!({ kind: "result", upload, load, storedBytes: reference.byteSize });
    } catch (error) { process.send!({ kind: "failed", error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
  });
}

async function run() {
  const mib = Number(option("mib", "200")), samples = Number(option("samples", "1")), restore = !process.argv.includes("--no-load");
  assert.ok(Number.isSafeInteger(mib) && mib >= 17 && mib <= 8192, "--mib must be between 17 and 8192");
  assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 5, "--samples must be between 1 and 5");
  const { startEmbeddedPostgresTestDatabase } = await import("../../packages/db/src/index.js");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-snapshot-crypto-benchmark-")));
  const children: ChildProcess[] = [];
  const start = async <T>(name: string, args: string[]) => {
    const child = fork(filename, [`--role=${name}`, ...args], { stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, TMPDIR: path.join(root, "tmp") } });
    children.push(child);
    return { child, ready: await message<T>(child, "ready") };
  };
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  try {
    await fs.mkdir(path.join(root, "tmp")); await fs.mkdir(path.join(root, "store")); await fs.mkdir(path.join(root, "work"));
    const archive = path.join(root, "archive.pcws"), handle = await fs.open(archive, "wx", 0o600), block = randomBytes(MIB);
    try { for (let index = 0; index < mib; index++) { block.writeUInt32BE(index, 0); await handle.writeFile(block); } } finally { await handle.close(); }
    database = await startEmbeddedPostgresTestDatabase("snapshot-crypto-benchmark-");
    const objectStore = await start<{ port: number }>("store", [`--root=${path.join(root, "store")}`]);
    const results = [];
    for (let sample = 0; sample < samples; sample++) {
      const subject = await start<{ port: number }>("server", [`--root=${path.join(root, "work")}`, `--archive=${archive}`,
        `--store=${objectStore.ready.port}`, `--database=${database.connectionString}`, `--load=${restore ? 1 : 0}`]);
      const prober = await start<object>("probe", [`--port=${subject.ready.port}`]);
      const loadAverage = round(os.loadavg()[0]!);
      subject.child.send({ kind: "run" });
      const measured = await message<{ upload: PhaseResult; load: PhaseResult | null; storedBytes: number }>(subject.child, "result");
      prober.child.send({ kind: "stop" });
      const probed = (await message<{ summary: ProbeResult }>(prober.child, "result")).summary;
      subject.child.send({ kind: "close" });
      results.push({ sample, archiveMib: mib, storedBytes: measured.storedBytes, loadAverage,
        upload: { ...measured.upload, unrelatedRequest: probed.upload },
        ...(measured.load ? { load: { ...measured.load, unrelatedRequest: probed.load } } : {}) });
    }
    objectStore.child.send({ kind: "close" });
    console.log(JSON.stringify({ node: process.version, cpus: os.cpus().length, results }, null, 2));
  } finally {
    for (const child of children) if (child.connected) child.kill();
    await database?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
}

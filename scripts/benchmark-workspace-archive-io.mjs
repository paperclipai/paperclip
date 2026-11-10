#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ARCHIVE_IO_BUFFER_BYTES } from "../server/src/services/remote-workspace-archive-io.ts";

const baselineBytes = 64 * 1024;
const archiveBytes = 32 * 1024 * 1024 + 137;
const contentionMs = 5;

async function worker(file, highWaterMark) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pc-archive-io-worker-"));
  const encrypted = path.join(scratch, "encrypted");
  global.gc?.();
  const initial = process.memoryUsage();
  let peakRss = initial.rss, peakExternal = initial.external, chunks = 0, loadTurns = 0;
  const observe = () => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss); peakExternal = Math.max(peakExternal, memory.external);
  };
  const digest = async name => {
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of createReadStream(name, { highWaterMark })) {
      hash.update(chunk); bytes += chunk.length; chunks++; observe();
    }
    return { sha256: hash.digest("hex"), bytes };
  };
  let active = true, pending;
  const load = () => {
    if (!active) return;
    const until = performance.now() + contentionMs;
    while (performance.now() < until) {}
    loadTurns++; pending = setImmediate(load);
  };
  pending = setImmediate(load);
  const start = performance.now();
  try {
    const verified = await digest(file), plaintext = await digest(file);
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 1), Buffer.alloc(12, 2));
    cipher.setAAD(Buffer.from("synthetic-workspace-archive-io-benchmark"));
    const header = await open(encrypted, "wx", 0o600);
    await header.writeFile(Buffer.concat([Buffer.from("PCWSE1\n"), Buffer.alloc(12, 2)])); await header.close();
    const incoming = createHash("sha256"); let incomingBytes = 0;
    const observed = new Transform({ transform(chunk, _encoding, callback) {
      incoming.update(chunk); incomingBytes += chunk.length; chunks++; observe(); callback(null, chunk);
    } });
    await pipeline(createReadStream(file, { highWaterMark }), observed, cipher,
      createWriteStream(encrypted, { flags: "a", mode: 0o600, highWaterMark }));
    const footer = await open(encrypted, "a"); await footer.writeFile(cipher.getAuthTag()); await footer.close();
    const ciphertext = await digest(encrypted);
    if (verified.sha256 !== plaintext.sha256 || incoming.digest("hex") !== plaintext.sha256
      || verified.bytes !== archiveBytes || incomingBytes !== archiveBytes) throw new Error("Integrity comparison failed");
    return { highWaterMark, bytes: archiveBytes, chunks, loadTurns, elapsedMs: Math.round(performance.now() - start),
      sha256: plaintext.sha256, encryptedSha256: ciphertext.sha256,
      peakRssGrowthBytes: Math.max(0, peakRss - initial.rss), peakExternalGrowthBytes: Math.max(0, peakExternal - initial.external),
      configuredReadWriteThresholdBytes: 2 * highWaterMark };
  } finally { active = false; clearImmediate(pending); await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[2] === "--worker") {
  console.log(JSON.stringify(await worker(process.argv[3], Number(process.argv[4]))));
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), "pc-archive-io-benchmark-")), file = path.join(root, "archive");
  try {
    const handle = await open(file, "wx", 0o600), block = randomBytes(1024 * 1024);
    try { for (let offset = 0; offset < archiveBytes; offset += block.length)
      await handle.writeFile(block.subarray(0, Math.min(block.length, archiveBytes - offset))); }
    finally { await handle.close(); }
    const samples = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      const order = iteration % 2 ? [WORKSPACE_ARCHIVE_IO_BUFFER_BYTES, baselineBytes] : [baselineBytes, WORKSPACE_ARCHIVE_IO_BUFFER_BYTES];
      for (const size of order) {
        const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--worker", file, String(size)],
          { encoding: "utf8", timeout: 60_000 });
        if (result.status !== 0) throw new Error(result.stderr || String(result.error));
        samples.push({ iteration, ...JSON.parse(result.stdout) });
      }
    }
    if (new Set(samples.map(sample => sample.sha256)).size !== 1
      || new Set(samples.map(sample => sample.encryptedSha256)).size !== 1) throw new Error("Baseline/treatment digests differ");
    console.log(JSON.stringify({ schema: "paperclip.workspace-archive-io-benchmark.v1", node: process.version,
      platform: `${process.platform}/${process.arch}`, contentionMsPerTurn: contentionMs,
      samples, identicalDigests: true, limits: "Synthetic main-thread contention; excludes sandbox, database, and object storage. RSS/GC samples are diagnostic. Stream thresholds bound queues, not total process memory." }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}

import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatRunLogRetentionSummary,
  RECOVERABLE_RUN_LOG_RETENTION_FS_CODES,
  resolveRunLogRetentionPolicyFromEnv,
  rotateRunLogs,
} from "../services/run-log-retention.js";

let workDir: string;

const DAY_MS = 24 * 60 * 60 * 1000;

async function writeRunLog(
  basePath: string,
  companyId: string,
  agentId: string,
  runId: string,
  contents: string,
  mtimeMs: number,
): Promise<string> {
  const agentDir = path.join(basePath, companyId, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  const filePath = path.join(agentDir, `${runId}.ndjson`);
  await fs.writeFile(filePath, contents);
  const mtimeSec = mtimeMs / 1000;
  await fs.utimes(filePath, mtimeSec, mtimeSec);
  return filePath;
}

async function writeGzipPlaceholder(
  basePath: string,
  companyId: string,
  agentId: string,
  runId: string,
  mtimeMs: number,
): Promise<string> {
  const agentDir = path.join(basePath, companyId, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  const filePath = path.join(agentDir, `${runId}.ndjson.gz`);
  // Empty gz placeholder; rotator only checks extension + mtime for deletion.
  await fs.writeFile(filePath, Buffer.alloc(16));
  const mtimeSec = mtimeMs / 1000;
  await fs.utimes(filePath, mtimeSec, mtimeSec);
  return filePath;
}

async function writeGzipTmpPlaceholder(
  basePath: string,
  companyId: string,
  agentId: string,
  runId: string,
  mtimeMs: number,
): Promise<string> {
  const agentDir = path.join(basePath, companyId, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  const filePath = path.join(agentDir, `${runId}.ndjson.gz.tmp`);
  await fs.writeFile(filePath, Buffer.alloc(16));
  const mtimeSec = mtimeMs / 1000;
  await fs.utimes(filePath, mtimeSec, mtimeSec);
  return filePath;
}

async function readGzipText(filePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  await pipeline(createReadStream(filePath), createGunzip(), async function* (source) {
    for await (const chunk of source) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      yield chunk;
    }
  });
  return Buffer.concat(chunks).toString("utf8");
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-retention-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("rotateRunLogs", () => {
  const policy = {
    uncompressedDays: 3,
    compressedDays: 7,
    maxFileBytes: 500 * 1024 * 1024,
    graceMinutes: 60,
  };

  it("gzips run-log files older than the uncompressed window", async () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const oldMtime = now.getTime() - 4 * DAY_MS;
    const target = await writeRunLog(workDir, "co-1", "agent-1", "run-old", "hello\nworld\n", oldMtime);

    const result = await rotateRunLogs({ basePath: workDir, policy, now });

    await expect(fs.access(target)).rejects.toThrow();
    const gz = `${target}.gz`;
    await expect(fs.access(gz)).resolves.toBeUndefined();
    expect(await readGzipText(gz)).toBe("hello\nworld\n");

    expect(result.scannedFiles).toBe(1);
    expect(result.gzippedFiles).toBe(1);
    expect(result.rotatedBytes).toBe("hello\nworld\n".length);
    expect(result.deletedFiles).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("keeps run-log files newer than the uncompressed window untouched", async () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const recentMtime = now.getTime() - 2 * DAY_MS;
    const target = await writeRunLog(workDir, "co-1", "agent-1", "run-recent", "x", recentMtime);

    const result = await rotateRunLogs({ basePath: workDir, policy, now });

    await expect(fs.access(target)).resolves.toBeUndefined();
    await expect(fs.access(`${target}.gz`)).rejects.toThrow();
    expect(result.gzippedFiles).toBe(0);
    expect(result.deletedFiles).toBe(0);
  });

  it("respects the grace window for very recent files even if size-eligible", async () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const justNow = now.getTime() - 5 * 60 * 1000; // 5 minutes ago
    const target = await writeRunLog(workDir, "co-1", "agent-1", "run-active", "abc", justNow);

    const result = await rotateRunLogs({
      basePath: workDir,
      policy: { ...policy, maxFileBytes: 1 }, // force size-eligible
      now,
    });

    await expect(fs.access(target)).resolves.toBeUndefined();
    await expect(fs.access(`${target}.gz`)).rejects.toThrow();
    expect(result.scannedFiles).toBe(1);
    expect(result.gzippedFiles).toBe(0);
  });

  it("gzips files past the max-size threshold even before the age window expires", async () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const pastGrace = now.getTime() - 2 * 60 * 60 * 1000; // 2h ago > 60min grace
    const big = Buffer.alloc(2048, "x").toString("utf8");
    const target = await writeRunLog(workDir, "co-1", "agent-1", "run-big", big, pastGrace);

    const result = await rotateRunLogs({
      basePath: workDir,
      policy: { ...policy, maxFileBytes: 1024 },
      now,
    });

    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.access(`${target}.gz`)).resolves.toBeUndefined();
    expect(result.gzippedFiles).toBe(1);
    expect(result.rotatedBytes).toBe(2048);
  });

  it("hard-deletes gzipped logs past the compressed window", async () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const ancient = now.getTime() - 10 * DAY_MS;
    const target = await writeGzipPlaceholder(workDir, "co-1", "agent-1", "run-ancient", ancient);

    const result = await rotateRunLogs({ basePath: workDir, policy, now });

    await expect(fs.access(target)).rejects.toThrow();
    expect(result.scannedFiles).toBe(1);
    expect(result.deletedFiles).toBe(1);
    expect(result.gzippedFiles).toBe(0);
  });

  it("also deletes uncompressed files past the compressed window (catch-up)", async () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const ancient = now.getTime() - 30 * DAY_MS;
    const target = await writeRunLog(workDir, "co-1", "agent-1", "run-ancient", "yyy", ancient);

    const result = await rotateRunLogs({ basePath: workDir, policy, now });

    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.access(`${target}.gz`)).rejects.toThrow();
    expect(result.deletedFiles).toBe(1);
  });

  it("deletes stale orphaned gzip temp files but leaves fresh temp files alone", async () => {
    const now = new Date("2026-05-10T12:00:00.000Z");
    const stale = now.getTime() - 2 * 60 * 60 * 1000;
    const fresh = now.getTime() - 5 * 60 * 1000;
    const staleTmp = await writeGzipTmpPlaceholder(workDir, "co-1", "agent-1", "run-stale", stale);
    const freshTmp = await writeGzipTmpPlaceholder(workDir, "co-1", "agent-1", "run-fresh", fresh);

    const result = await rotateRunLogs({ basePath: workDir, policy, now });

    await expect(fs.access(staleTmp)).rejects.toThrow();
    await expect(fs.access(freshTmp)).resolves.toBeUndefined();
    expect(result.scannedFiles).toBe(2);
    expect(result.deletedFiles).toBe(1);
    expect(result.gzippedFiles).toBe(0);
  });

  it("no-ops cleanly when the base path does not exist", async () => {
    const missing = path.join(workDir, "missing");
    const result = await rotateRunLogs({
      basePath: missing,
      policy,
      now: new Date("2026-05-10T12:00:00.000Z"),
    });
    expect(result.scannedFiles).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("formats the one-line operator summary", () => {
    expect(
      formatRunLogRetentionSummary({
        scannedFiles: 5,
        rotatedBytes: 12345,
        gzippedFiles: 2,
        deletedFiles: 3,
        errors: 0,
      }),
    ).toBe("runner-logs: rotated 12345 bytes, gz'd 2 files, deleted 3 files");
  });
});

describe("resolveRunLogRetentionPolicyFromEnv", () => {
  it("returns documented defaults when no env vars are set", () => {
    const policy = resolveRunLogRetentionPolicyFromEnv({});
    expect(policy).toEqual({
      uncompressedDays: 3,
      compressedDays: 7,
      maxFileBytes: 500 * 1024 * 1024,
      graceMinutes: 60,
    });
  });

  it("accepts env overrides for each knob", () => {
    const policy = resolveRunLogRetentionPolicyFromEnv({
      PAPERCLIP_RUN_LOG_UNCOMPRESSED_DAYS: "1",
      PAPERCLIP_RUN_LOG_COMPRESSED_DAYS: "5",
      PAPERCLIP_RUN_LOG_MAX_FILE_BYTES: "1048576",
      PAPERCLIP_RUN_LOG_ROTATE_GRACE_MINUTES: "10",
    });
    expect(policy).toEqual({
      uncompressedDays: 1,
      compressedDays: 5,
      maxFileBytes: 1_048_576,
      graceMinutes: 10,
    });
  });

  it("ignores malformed env values", () => {
    const policy = resolveRunLogRetentionPolicyFromEnv({
      PAPERCLIP_RUN_LOG_UNCOMPRESSED_DAYS: "not-a-number",
      PAPERCLIP_RUN_LOG_COMPRESSED_DAYS: "-3",
    });
    expect(policy.uncompressedDays).toBe(3);
    expect(policy.compressedDays).toBe(7);
  });

  it("ignores zero env values because retention windows must be strictly positive", () => {
    const policy = resolveRunLogRetentionPolicyFromEnv({
      PAPERCLIP_RUN_LOG_UNCOMPRESSED_DAYS: "0",
      PAPERCLIP_RUN_LOG_COMPRESSED_DAYS: "0",
      PAPERCLIP_RUN_LOG_MAX_FILE_BYTES: "0",
      PAPERCLIP_RUN_LOG_ROTATE_GRACE_MINUTES: "0",
    });
    expect(policy).toEqual({
      uncompressedDays: 3,
      compressedDays: 7,
      maxFileBytes: 500 * 1024 * 1024,
      graceMinutes: 60,
    });
  });

  it("treats disk quota errors as recoverable during retention scans", () => {
    expect(RECOVERABLE_RUN_LOG_RETENTION_FS_CODES.has("EDQUOT")).toBe(true);
  });
});

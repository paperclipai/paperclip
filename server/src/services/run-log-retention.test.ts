import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { pruneRunLogs, resolveRunLogArchivePath } from "./run-log-retention.js";

let rootDir: string;
let archiveDir: string;

beforeEach(async () => {
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-retention-root-"));
  archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-retention-archive-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.rm(archiveDir, { recursive: true, force: true });
});

async function writeFileWithAge(filePath: string, ageDays: number, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  const timestamp = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1_000);
  await fs.utimes(filePath, timestamp, timestamp);
}

describe("pruneRunLogs", () => {
  it("archives old run logs to the configured path and leaves recent logs in place", async () => {
    const oldFile = path.join(rootDir, "co1", "ag1", "old.ndjson");
    const newFile = path.join(rootDir, "co1", "ag1", "new.ndjson");
    const noteFile = path.join(rootDir, "co1", "ag1", "note.txt");
    await writeFileWithAge(oldFile, 10, "old-run");
    await writeFileWithAge(newFile, 1, "new-run");
    await writeFileWithAge(noteFile, 10, "keep-me");

    const result = await pruneRunLogs({
      basePath: rootDir,
      archivePath: archiveDir,
      retentionDays: 7,
    });

    expect(result.scannedFiles).toBe(2);
    expect(result.prunedFiles).toBe(1);
    expect(result.archivedFiles).toBe(1);
    await expect(fs.stat(oldFile)).rejects.toThrow();
    await expect(fs.readFile(path.join(archiveDir, "co1", "ag1", "old.ndjson"), "utf8")).resolves.toBe("old-run");
    await expect(fs.readFile(newFile, "utf8")).resolves.toBe("new-run");
    await expect(fs.readFile(noteFile, "utf8")).resolves.toBe("keep-me");
  });

  it("supports dry-run mode without mutating local files", async () => {
    const oldFile = path.join(rootDir, "co1", "ag1", "old.ndjson");
    await writeFileWithAge(oldFile, 10, "old-run");

    const result = await pruneRunLogs({
      basePath: rootDir,
      archivePath: archiveDir,
      retentionDays: 7,
      dryRun: true,
    });

    expect(result.prunedFiles).toBe(1);
    expect(result.archivedFiles).toBe(1);
    await expect(fs.readFile(oldFile, "utf8")).resolves.toBe("old-run");
    await expect(fs.stat(path.join(archiveDir, "co1", "ag1", "old.ndjson"))).rejects.toThrow();
  });

  it("skips the sweep when the archive volume path is unavailable", async () => {
    const oldFile = path.join(rootDir, "co1", "ag1", "old.ndjson");
    await writeFileWithAge(oldFile, 10, "old-run");

    const result = await pruneRunLogs({
      basePath: rootDir,
      archivePath: "/Volumes/Definitely-Missing/ThinkStack-DR/Paperclip-Run-Logs",
      retentionDays: 7,
    });

    expect(result.archiveSkipped).toBe(true);
    expect(result.prunedFiles).toBe(0);
    await expect(fs.readFile(oldFile, "utf8")).resolves.toBe("old-run");
  });
});

describe("resolveRunLogArchivePath", () => {
  it("defaults the instance run-log path to the ThinkStack DR volume", () => {
    const archivePath = resolveRunLogArchivePath({
      basePath: path.join(resolvePaperclipInstanceRoot(), "data", "run-logs"),
    });

    expect(archivePath).toBe("/Volumes/X10 Pro/ThinkStack-DR/paperclip/instances/default/run-logs");
  });

  it("does not force the DR archive path for custom run-log roots", () => {
    const archivePath = resolveRunLogArchivePath({
      basePath: "/tmp/custom-run-logs",
    });

    expect(archivePath).toBeUndefined();
  });
});

import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneExpiredRunLogs } from "../services/run-log-store.js";

describe("pruneExpiredRunLogs", () => {
  it("prunes only files older than retention and removes empty directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-retention-"));
    try {
      const oldFile = path.join(root, "company-a", "agent-a", "old.ndjson");
      const newFile = path.join(root, "company-a", "agent-a", "new.ndjson");
      await mkdir(path.dirname(oldFile), { recursive: true });
      await writeFile(oldFile, "old-log", "utf8");
      await writeFile(newFile, "new-log", "utf8");

      const now = new Date("2026-04-30T00:00:00.000Z");
      const oldMtime = new Date(now.getTime() - (40 * 24 * 60 * 60 * 1_000));
      const newMtime = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1_000));
      await utimes(oldFile, oldMtime, oldMtime);
      await utimes(newFile, newMtime, newMtime);

      const summary = await pruneExpiredRunLogs({
        basePath: root,
        retentionDays: 30,
        now,
      });

      expect(summary.scannedFiles).toBe(2);
      expect(summary.prunedFiles).toBe(1);
      expect(summary.prunedBytes).toBeGreaterThan(0);

      await expect(stat(oldFile)).rejects.toThrow();
      await expect(stat(newFile)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors maxDeletes to bound each sweep", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-retention-bound-"));
    try {
      const now = new Date("2026-04-30T00:00:00.000Z");
      const oldMtime = new Date(now.getTime() - (40 * 24 * 60 * 60 * 1_000));

      for (let i = 0; i < 3; i += 1) {
        const filePath = path.join(root, "company-b", "agent-b", `run-${i}.ndjson`);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, `log-${i}`, "utf8");
        await utimes(filePath, oldMtime, oldMtime);
      }

      const summary = await pruneExpiredRunLogs({
        basePath: root,
        retentionDays: 30,
        maxDeletes: 2,
        now,
      });

      expect(summary.scannedFiles).toBe(3);
      expect(summary.prunedFiles).toBe(2);

      const remainingPath = path.join(root, "company-b", "agent-b", "run-2.ndjson");
      await expect(stat(remainingPath)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

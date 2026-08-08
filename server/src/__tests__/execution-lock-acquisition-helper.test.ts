import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ISSUE_EXECUTION_LOCK_TTL_MS, executionLockAcquisitionFields } from "../services/issues.js";

describe("execution lock acquisition helper usage", () => {
  it("always schedules the exact execution-lock reaper deadline", () => {
    const now = new Date("2026-08-08T03:15:00.000Z");

    expect(executionLockAcquisitionFields("run-1", now)).toEqual({
      executionRunId: "run-1",
      executionLockedAt: now,
      monitorNextCheckAt: new Date(now.getTime() + ISSUE_EXECUTION_LOCK_TTL_MS),
      monitorWakeRequestedAt: null,
    });
  });

  it("keeps an earlier validated review-monitor deadline ahead of the lock reaper", () => {
    const now = new Date("2026-08-08T03:15:00.000Z");
    const reviewDeadline = new Date("2026-08-08T03:17:00.000Z");

    expect(executionLockAcquisitionFields("run-1", now, reviewDeadline)).toMatchObject({
      monitorNextCheckAt: reviewDeadline,
    });
  });

  it("keeps production execution lock acquisition writes centralized", async () => {
    const root = process.cwd();
    const productionFiles = [
      "server/src/services/issues.ts",
      "server/src/services/heartbeat.ts",
      "server/src/services/recovery/service.ts",
      "server/src/routes/issues.ts",
    ];

    const directAcquisitions: string[] = [];
    for (const file of productionFiles) {
      const source = await readFile(path.join(root, file), "utf8");
      source.split(/\r?\n/).forEach((line, index) => {
        if (/executionLockedAt:\s*(now|new Date\()/.test(line) && !file.endsWith("issues.ts")) {
          directAcquisitions.push(`${file}:${index + 1}:${line.trim()}`);
        }
      });
    }

    expect(directAcquisitions).toEqual([]);
  });

  it("removes scheduleMonitor option plumbing from every production acquisition path", async () => {
    const root = process.cwd();
    const productionFiles = [
      "server/src/services/issues.ts",
      "server/src/services/heartbeat.ts",
    ];

    const optionUses: string[] = [];
    for (const file of productionFiles) {
      const source = await readFile(path.join(root, file), "utf8");
      source.split(/\r?\n/).forEach((line, index) => {
        if (/scheduleMonitor/.test(line)) optionUses.push(`${file}:${index + 1}:${line.trim()}`);
      });
    }

    expect(optionUses).toEqual([]);
  });
});

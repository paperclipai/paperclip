import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { executionLockAcquisitionFields } from "../services/issues.js";

describe("execution lock acquisition helper usage", () => {
  it("does not create a scheduled review monitor when acquiring an execution lock", () => {
    const now = new Date("2026-08-08T03:15:00.000Z");

    expect(executionLockAcquisitionFields("run-1", now)).toEqual({
      executionRunId: "run-1",
      executionLockedAt: now,
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
});

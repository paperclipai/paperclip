import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { rotateRunLogs, formatRunLogRetentionSummary } from "../services/run-log-retention.js";

// Opt-in: this test writes a real 600 MB file and gzips it. Gated on
// PAPERCLIP_TEST_LARGE_FIXTURES=1 to keep CI from allocating that much disk
// on every run. The unit tests in run-log-retention.test.ts cover the same
// code paths with small fixtures; this test verifies the HFT-167 acceptance
// criterion ("retention verified locally against a synthetic >500 MB log").
const RUN_LARGE = process.env.PAPERCLIP_TEST_LARGE_FIXTURES === "1";
const maybeIt = RUN_LARGE ? it : it.skip;

let workDir: string;

afterAll(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

describe("rotateRunLogs synthetic >500 MB e2e", () => {
  maybeIt("gzips a 600 MB run-log past size threshold and reports a one-line summary", async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "hft167-"));
    const agentDir = path.join(workDir, "co-1", "agent-1");
    await fs.mkdir(agentDir, { recursive: true });
    const target = path.join(agentDir, "run-big.ndjson");

    const sizeBytes = 600 * 1024 * 1024;
    const chunk = Buffer.alloc(4 * 1024 * 1024, "a"); // 4 MiB filler
    const handle = await fs.open(target, "w");
    let written = 0;
    while (written < sizeBytes) {
      await handle.write(chunk);
      written += chunk.length;
    }
    await handle.close();

    // Force mtime well past grace window.
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await fs.utimes(target, twoHoursAgo, twoHoursAgo);

    const result = await rotateRunLogs({
      basePath: workDir,
      policy: {
        uncompressedDays: 3,
        compressedDays: 7,
        maxFileBytes: 500 * 1024 * 1024,
        graceMinutes: 60,
      },
    });

    await expect(fs.access(target)).rejects.toThrow();
    const gz = `${target}.gz`;
    const gzStat = await fs.stat(gz);
    expect(gzStat.size).toBeGreaterThan(0);
    expect(gzStat.size).toBeLessThan(sizeBytes);

    expect(result.scannedFiles).toBe(1);
    expect(result.gzippedFiles).toBe(1);
    expect(result.rotatedBytes).toBe(sizeBytes);
    expect(result.deletedFiles).toBe(0);
    expect(result.errors).toBe(0);

    console.log("summary:", formatRunLogRetentionSummary(result), "gz_size_bytes=", gzStat.size);
  }, 600_000);
});

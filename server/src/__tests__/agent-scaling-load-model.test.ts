import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../../scripts/benchmark-agent-scaling-load.ts", import.meta.url));
const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx/cli");

describe("agent scaling load model", () => {
  // The default batches deltas and renews every lease in one tick; the other
  // mode is the earlier one transaction per delta and per lease.
  it.each([
    { mode: "batched deltas and shared lease renewal", env: {} },
    { mode: "one transaction per delta and per lease", env: { DELTA_BATCH_MS: "0", LEASE_MODE: "single" } },
  ])("drives every source through the real server code and reports each pool ($mode)", async ({ env }) => {
    const { stdout } = await run(process.execPath, [tsx, script], {
      cwd: serverRoot, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, AGENTS: "2", SECONDS: "2", DELTAS_PER_S: "5", EVENTS_PER_S: "2", API_PER_S: "1", LEASE_S: "1", ...env },
    });
    const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
      database: { meteredStatementsPerSecondByPool: Record<"main" | "checkpoint" | "lease", number> };
      checkpointSaves: { failed: number };
      bySource: Record<string, { offered: number; done: number; failed: number }>;
    };
    expect(Object.keys(report.bySource).sort()).toEqual(["api", "deltas", "events", "lease"]);
    for (const [source, result] of Object.entries(report.bySource)) {
      expect(result.failed, source).toBe(0);
      expect(result.done, source).toBeGreaterThan(0);
      // Counts freeze with the window: work that settles later is not done.
      expect(result.done, source).toBeLessThanOrEqual(result.offered);
    }
    // A failed save is reported, not dropped.
    expect(report.checkpointSaves.failed).toBe(0);
    // Deltas, events and API requests use the main pool; checkpoint saves and
    // lease renewals use their own. Each pool must be counted on its own, or a
    // comparison understates the sources that use it.
    expect(report.database.meteredStatementsPerSecondByPool.main).toBeGreaterThan(0);
    expect(report.database.meteredStatementsPerSecondByPool.checkpoint).toBeGreaterThan(0);
    expect(report.database.meteredStatementsPerSecondByPool.lease).toBeGreaterThan(0);
  }, 240_000);
});

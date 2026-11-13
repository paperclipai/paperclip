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
  it("drives every source through the real server code and reports each pool", async () => {
    const { stdout } = await run(process.execPath, [tsx, script], {
      cwd: serverRoot, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, AGENTS: "2", SECONDS: "2", DELTAS_PER_S: "5", EVENTS_PER_S: "2", API_PER_S: "1", LEASE_S: "1" },
    });
    const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
      database: { meteredStatementsPerSecond: number; meteredTransactionsPerSecond: number; commitsPerSecondAllPools: number };
      checkpointSaves: { failed: number };
      bySource: Record<string, { offered: number; done: number; failed: number }>;
    };
    expect(Object.keys(report.bySource).sort()).toEqual(["api", "deltas", "events", "lease"]);
    for (const [source, result] of Object.entries(report.bySource)) {
      expect(result.failed, source).toBe(0);
      expect(result.done, source).toBeGreaterThan(0);
    }
    // A failed save is reported, not dropped.
    expect(report.checkpointSaves.failed).toBe(0);
    // Deltas, events and API requests use the main pool; saves and renewals
    // use their own. The metered transactions must cover all of them, so they
    // cannot fall far below what the database committed.
    expect(report.database.meteredStatementsPerSecond).toBeGreaterThan(0);
    expect(report.database.meteredTransactionsPerSecond).toBeGreaterThan(report.database.commitsPerSecondAllPools * 0.5);
  }, 240_000);
});

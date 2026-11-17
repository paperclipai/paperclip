import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { finishDaytonaCleanup } from "./daytona-cleanup.js";
import type { DaytonaSweepResult, WaveCleanup } from "./daytona-sweep.js";

const sweep: DaytonaSweepResult = { companyId: "c", environmentId: "e", checkedAt: "now", liveSandboxes: ["s1"], orphanSandboxes: [], heldLeases: [],
  retainedLeases: [], archivedSandboxes: ["s1"], error: null };
const clean: WaveCleanup = { environmentDeleted: true, environmentDeleteBlocked: null, remainingSandboxes: [], archivedSandboxes: ["s1:archived"],
  deletedSandboxes: ["s1:archived"], undeletedSandboxes: [], errors: [] };

async function run(cleanup: WaveCleanup, saved: DaytonaSweepResult | null) {
  const waveDir = await mkdtemp(path.join(os.tmpdir(), "daytona-cleanup-"));
  const kinds: string[] = [], lines: string[] = [];
  let swept = 0;
  try {
    const outcome = await finishDaytonaCleanup({ sweeper: { sweep: async () => { swept += 1; return sweep; }, cleanUp: async () => cleanup }, sweep: saved, waveDir,
      timeline: { add: kind => { kinds.push(kind); } }, log: line => { lines.push(line); } });
    const file = JSON.parse(await readFile(path.join(waveDir, "sandbox-sweep.json"), "utf8"));
    return { outcome, kinds, lines, swept, file };
  } finally {
    await rm(waveDir, { recursive: true, force: true });
  }
}

describe("wave-end Daytona cleanup", () => {
  it("passes a wave whose sandboxes were all deleted, and sweeps first when the wave was interrupted", async () => {
    const { outcome, kinds, lines, swept, file } = await run(clean, null);
    expect(outcome).toMatchObject({ failed: false, remotePending: false, error: null, sweep });
    expect(swept).toBe(1);
    expect(kinds).toEqual(["daytona_cleanup"]);
    expect(lines[0]).toContain("deleted by the harness (this wave's labels only): s1:archived; left after deletion: none");
    expect(file).toEqual({ sweep, cleanup: clean });
  });

  it("fails the wave for a sandbox left after deletion, a blocked environment delete or a still-running sandbox, and reports errors", async () => {
    expect((await run({ ...clean, undeletedSandboxes: ["s1:archived"] }, sweep)).outcome).toMatchObject({ failed: true, remotePending: true });
    const blocked = await run({ ...clean, environmentDeleted: false, environmentDeleteBlocked: "409" }, sweep);
    expect(blocked.outcome).toMatchObject({ failed: true, remotePending: true });
    expect(blocked.kinds).toEqual(["daytona_cleanup", "daytona_environment_delete_blocked"]);
    expect(blocked.swept).toBe(0);
    expect((await run({ ...clean, remainingSandboxes: ["s2:started"] }, sweep)).outcome.failed).toBe(true);
    const errored = await run({ ...clean, errors: ["sandbox delete s1: boom"] }, sweep);
    expect(errored.outcome).toMatchObject({ failed: false, remotePending: true });
    expect(errored.outcome.error?.message).toBe("Daytona cleanup incomplete: sandbox delete s1: boom");
  });
});

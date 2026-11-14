import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { DaytonaSweepResult, DaytonaWaveSweeper, WaveCleanup } from "./daytona-sweep.js";

export interface DaytonaCleanupOutcome {
  sweep: DaytonaSweepResult;
  cleanup: WaveCleanup;
  failed: boolean;
  remotePending: boolean;
  error: Error | null;
}

const list = (values: readonly string[]) => values.join(", ") || "none";

export function daytonaCleanupLine(sweep: DaytonaSweepResult, cleanup: WaveCleanup): string {
  return `Daytona R6 sweep: ${sweep.liveSandboxes.length} live, ${sweep.archivedSandboxes.length} archived after release, `
    + `${sweep.orphanSandboxes.length} orphaned, ${sweep.heldLeases.length} held leases${sweep.error ? `, error ${sweep.error}` : ""}; `
    + `environment deleted: ${cleanup.environmentDeleted}${cleanup.environmentDeleteBlocked ? " (still blocked by a pending sandbox cleanup)" : ""}; `
    + `still running after cleanup: ${list(cleanup.remainingSandboxes)}; archived: ${list(cleanup.archivedSandboxes)}; `
    + `deleted by the harness (this wave's labels only): ${list(cleanup.deletedSandboxes)}; left after deletion: ${list(cleanup.undeletedSandboxes)}`;
}

export async function finishDaytonaCleanup(input: { sweeper: Pick<DaytonaWaveSweeper, "sweep" | "cleanUp">; sweep: DaytonaSweepResult | null; waveDir: string;
  timeline: { add(kind: string, data: Record<string, unknown>): void }; log?: (line: string) => void }): Promise<DaytonaCleanupOutcome> {
  const sweep = input.sweep ?? await input.sweeper.sweep(0);
  const cleanup = await input.sweeper.cleanUp();
  input.timeline.add("daytona_cleanup", cleanup);
  (input.log ?? console.info)(daytonaCleanupLine(sweep, cleanup));
  if (cleanup.environmentDeleteBlocked) input.timeline.add("daytona_environment_delete_blocked", { detail: cleanup.environmentDeleteBlocked });
  const failed = Boolean(cleanup.remainingSandboxes.length || cleanup.undeletedSandboxes.length || cleanup.environmentDeleteBlocked);
  await writeFile(path.join(input.waveDir, "sandbox-sweep.json"), `${JSON.stringify({ sweep, cleanup }, null, 2)}\n`, { mode: 0o600 })
    .catch(error => input.timeline.add("sandbox_sweep_write_failed", { error: String(error) }));
  return { sweep, cleanup, failed, remotePending: failed || cleanup.errors.length > 0,
    error: cleanup.errors.length ? new Error(`Daytona cleanup incomplete: ${cleanup.errors.join("; ")}`) : null };
}

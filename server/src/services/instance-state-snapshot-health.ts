import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function inspectInstanceStateSnapshotHealth(opts: { markerDir: string; enabled: boolean; maxAgeHours: number; now?: Date }) {
  const successPath = path.join(opts.markerDir, "state-snapshot.success.json");
  const failurePath = path.join(opts.markerDir, "state-snapshot.failure");
  const warnings: Array<{ code: string; message: string }> = [];
  let latestSnapshot: Record<string, unknown> | null = null;
  if (existsSync(successPath)) {
    latestSnapshot = JSON.parse(readFileSync(successPath, "utf8"));
    const ageHours = ((opts.now ?? new Date()).getTime() - statSync(successPath).mtimeMs) / 3_600_000;
    if (ageHours > opts.maxAgeHours) warnings.push({ code: "instance_state_snapshot_stale", message: `Latest instance-state snapshot is ${Math.round(ageHours * 10) / 10}h old.` });
  } else warnings.push({ code: "instance_state_snapshot_missing", message: "No successful instance-state snapshot marker found." });
  if (existsSync(failurePath)) warnings.push({ code: "instance_state_snapshot_last_failure", message: readFileSync(failurePath, "utf8").trim().split(/\r?\n/)[0] });
  return { enabled: opts.enabled, status: warnings.length ? "warning" : "ok", markerDir: opts.markerDir, latestSnapshot, warnings };
}

import type { heartbeatRuns } from "@paperclipai/db";
import { proveOwnerGone, type LocalOwnerStamp, type OwnerProof, type ProcessProbe } from "./owner-proof.js";
import { runProcessOwnerStamp } from "./native-runtime/native-owner-stamps.js";

/** The process identity a heartbeat run records for its adapter child
 * (`persistHeartbeatRunProcessMetadata`). */
export type RunProcessIdentity = Pick<typeof heartbeatRuns.$inferSelect,
  "processPid" | "processGroupId" | "processStartedAt" | "processHostHash">;

/**
 * The owner stamp the lost-process reapers judge a run's adapter child by.
 *
 * It is the shared `runProcessOwnerStamp` (native-owner-stamps.ts) with the
 * one-release local proof for rows saved before `process_host_hash` (#19871,
 * #19883; single-host servers only). A row that recorded only a process group
 * is judged by that group: its leader's PID is the group id. The active
 * execution reaper, the orphan sweep and hot-restart adoption all read it, so
 * they reach one verdict for one row.
 *
 * Returns null when the run recorded no process.
 */
export function lostProcessOwnerStamp(run: RunProcessIdentity, scope: string): LocalOwnerStamp | null {
  const pid = run.processPid ?? run.processGroupId ?? null;
  if (pid === null) return null;
  return runProcessOwnerStamp({ ...run, processPid: pid }, scope, { legacyFallback: true });
}

/** Proves whether a run's adapter child is gone. Null when no process was
 * recorded. `unprovable` never releases the run: its operator action is Stop. */
export async function proveRunProcessGone(run: RunProcessIdentity, scope: string,
  probe?: ProcessProbe): Promise<OwnerProof | null> {
  const stamp = lostProcessOwnerStamp(run, scope);
  return stamp ? proveOwnerGone(stamp, probe) : null;
}

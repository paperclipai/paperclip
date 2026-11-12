/**
 * Test-only sandbox disk-full fault (restart-chaos DF1, tests/restart-chaos/disk-full-faults.ts).
 *
 * A real full sandbox disk cannot be made on demand, locally or on Daytona. This hook makes a
 * final workspace save see what a full sandbox returns, and leaves every decision after that to
 * the product: the save's own failure handling, finalization, saved-work recovery and Retry.
 *
 * Arming (test mode only), in the same style as `@paperclipai/shared/crash-points`:
 *
 *   PAPERCLIP_DISK_FULL_FAULT_CONTROL=<file>  each final save reads this file. A line that equals
 *                                             the save's issue id or run id arms that save. No file,
 *                                             or no matching line, means disarmed.
 *   PAPERCLIP_DISK_FULL_FAULT_RECEIPT=<file>  optional; one JSON line is appended per faulted save.
 *
 * While a save is armed, every sandbox command its capture runs exits 1 with the exact message the
 * in-sandbox capture script writes on ENOSPC, and the provider's file download fails with tar's
 * "No space left on device". Restore and other operations are untouched.
 *
 * The variable is read once, when this module is first imported, and is ignored when
 * `NODE_ENV=production`. Disarmed, the hook is one comparison against a module constant and
 * returns the save's own target. Only the chaos harness sets the variable, on the server it starts.
 *
 * This is test instrumentation, not Telemetry or Observability: nothing is recorded or sent
 * anywhere unless a test arms a save.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL, type RemoteWorkspaceTarget } from "./remote-workspace-transport.js";

export const DISK_FULL_FAULT_CONTROL_ENV = "PAPERCLIP_DISK_FULL_FAULT_CONTROL";
export const DISK_FULL_FAULT_RECEIPT_ENV = "PAPERCLIP_DISK_FULL_FAULT_RECEIPT";
/** The provider download's failure on a full disk: tar cannot write its archive. */
export const DISK_FULL_FAULT_SYNC_OUT_MESSAGE = "tar: workspace archive: Cannot write: No space left on device";

export type DiskFullFaultReceipt = { issueId: string | null; runId: string; boundary: string; pid: number; at: string };

type Gate = { controlPath: string; receiptPath: string | null };

export function readDiskFullFaultGate(env: NodeJS.ProcessEnv | undefined): Gate | null {
  if (!env || env.NODE_ENV === "production") return null;
  const controlPath = env[DISK_FULL_FAULT_CONTROL_ENV]?.trim();
  if (!controlPath) return null;
  return { controlPath, receiptPath: env[DISK_FULL_FAULT_RECEIPT_ENV]?.trim() || null };
}

let gate: Gate | null = readDiskFullFaultGate(typeof process === "undefined" ? undefined : process.env);
if (gate) process.stderr.write(`[disk-full-fault] armed from ${gate.controlPath} pid=${process.pid}\n`);

function armed(current: Gate, ids: readonly string[]): boolean {
  let text: string;
  try { text = readFileSync(current.controlPath, "utf8"); } catch { return false; }
  const lines = new Set(text.split("\n").map(line => line.trim()).filter(Boolean));
  return ids.some(id => lines.has(id));
}

/**
 * The target a workspace save captures through. Disarmed, or for any boundary other than the
 * final copy-back, it is `target` itself.
 */
export function sandboxDiskFullFaultTarget<T extends RemoteWorkspaceTarget>(target: T,
  save: { boundary: string; issueId: string | null; runId: string }): T {
  if (gate === null) return target;
  if (save.boundary !== "final" || !armed(gate, [save.runId, ...(save.issueId ? [save.issueId] : [])])) return target;
  const receipt: DiskFullFaultReceipt = { issueId: save.issueId, runId: save.runId, boundary: save.boundary,
    pid: process.pid, at: new Date().toISOString() };
  if (gate.receiptPath) {
    try { appendFileSync(gate.receiptPath, `${JSON.stringify(receipt)}\n`); } catch { /* the log line still records it */ }
  }
  process.stderr.write(`[disk-full-fault] save ${JSON.stringify(receipt)}\n`);
  const runner = target.runner!;
  const full = Object.create(runner) as typeof runner;
  full.execute = async () => ({ exitCode: 1, signal: null, timedOut: false, stdout: "",
    stderr: REMOTE_WORKSPACE_SANDBOX_DISK_FULL, pid: null, startedAt: null });
  if (runner.syncOut) full.syncOut = async () => { throw new Error(DISK_FULL_FAULT_SYNC_OUT_MESSAGE); };
  return { ...target, runner: full };
}

/** Replaces the gate inside a test process; returns a function that restores the previous one. */
export function setDiskFullFaultGateForTest(next: Gate | null): () => void {
  const previous = gate;
  gate = next;
  return () => { gate = previous; };
}

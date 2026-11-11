/**
 * Test-only run accounting fault (chat eval `budgets-costs.repair-cost-recording`).
 *
 * Saved usage becomes "Ready to record" in Costs only while accounting a finished run keeps
 * failing; any other run is settled within seconds by completion or the accounting worker. A
 * real transient database failure cannot be made on demand, so this hook makes one run's
 * accounting fail the way a dropped database connection does, and leaves every decision after
 * that to the product: the queued retries, the Costs page and the person's "Retry cost recording".
 *
 * Arming (test mode only), in the same style as `sandbox-disk-full-fault.ts`:
 *
 *   PAPERCLIP_ACCOUNTING_FAULT_CONTROL=<file>  each accounting attempt reads this file. A line that
 *                                              equals the run's attributed task (issue) id arms that
 *                                              run. No file, or no matching line, means disarmed.
 *
 * The fault is thrown before accounting reads receipts or opens its transaction, so an armed
 * attempt writes nothing; removing the line lets the next attempt settle normally.
 *
 * The variable is read once, when this module is first imported, and is ignored when
 * `NODE_ENV=production`. Disarmed, the hook is one comparison against a module constant. Only the
 * Runner E2E harness sets the variable, on the server it starts.
 *
 * This is test instrumentation, not Telemetry or Observability: nothing is recorded or sent
 * anywhere unless a test arms a run.
 */
import { readFileSync } from "node:fs";

export const ACCOUNTING_FAULT_CONTROL_ENV = "PAPERCLIP_ACCOUNTING_FAULT_CONTROL";

export function readAccountingFaultControlPath(env: NodeJS.ProcessEnv | undefined): string | null {
  if (!env || env.NODE_ENV === "production") return null;
  return env[ACCOUNTING_FAULT_CONTROL_ENV]?.trim() || null;
}

let controlPath = readAccountingFaultControlPath(typeof process === "undefined" ? undefined : process.env);

/** The shape of a dropped control-plane connection: transient, and retried by accounting recovery. */
export function accountingFaultError(runId: string): Error {
  return new Error(`Failed query: select "heartbeat_runs" for run accounting\nparams: ${runId}`, {
    cause: Object.assign(new Error("terminating connection due to administrator command"), { name: "PostgresError", code: "57P01" }),
  });
}

/** Throws for an armed run before any accounting work; a single null check when disarmed. */
export function injectRunAccountingFault(input: { runId: string; issueId: string | null }): void {
  if (controlPath === null || !input.issueId) return;
  let text: string;
  try { text = readFileSync(controlPath, "utf8"); } catch { return; }
  if (!text.split("\n").some(line => line.trim() === input.issueId)) return;
  process.stderr.write(`[accounting-fault] run ${input.runId} issue ${input.issueId}\n`);
  throw accountingFaultError(input.runId);
}

/** Replaces the control path inside a test process; returns a function that restores the previous one. */
export function setAccountingFaultControlPathForTest(next: string | null): () => void {
  const previous = controlPath;
  controlPath = next;
  return () => { controlPath = previous; };
}

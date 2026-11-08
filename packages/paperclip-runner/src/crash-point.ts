/**
 * Runner-side crash points: the same `PAPERCLIP_CRASH_POINT` contract as
 * `@paperclipai/shared/crash-points`, for the controller code in this package
 * (it runs inside the Paperclip server process). This package does not depend
 * on `@paperclipai/shared`, so it keeps this small copy; the names are checked
 * against the shared registry by server/src/__tests__/crash-point-call-sites.test.ts.
 *
 * Disarmed (always under NODE_ENV=production) a call is one comparison.
 * runnerd never sees the variable: its environment is an allowlist.
 */
import { appendFileSync, existsSync } from "node:fs";

export type RunnerCrashPointName =
  | "runner.process.after_spawn_before_identity"
  | "runner.turn_start.after_runner_accept_before_controller_checkpoint"
  | "runner.turn_start.after_controller_journal_before_db_checkpoint";

type Armed = { name: string; nth: number; hits: number; receiptPath: string | null; gatePath: string | null };

function armFromEnvironment(): Armed | null {
  const env = typeof process === "undefined" ? undefined : process.env;
  const raw = env?.PAPERCLIP_CRASH_POINT?.trim();
  if (!env || !raw || env.NODE_ENV === "production") return null;
  const separator = raw.lastIndexOf(":");
  const name = separator === -1 ? raw : raw.slice(0, separator);
  // The shared helper validates the name; this copy only arms its own names.
  if (!name.startsWith("runner.")) return null;
  const nth = separator === -1 ? 1 : Number(raw.slice(separator + 1));
  if (!Number.isInteger(nth) || nth < 1) return null;
  return { name, nth, hits: 0, receiptPath: env.PAPERCLIP_CRASH_POINT_RECEIPT?.trim() || null,
    gatePath: env.PAPERCLIP_CRASH_POINT_GATE?.trim() || null };
}

const armed: Armed | null = armFromEnvironment();

export function crashPoint(name: RunnerCrashPointName): void {
  if (armed === null || armed.name !== name) return;
  if (armed.gatePath !== null) {
    if (!existsSync(armed.gatePath)) return;
    armed.gatePath = null;
  }
  armed.hits += 1;
  if (armed.hits !== armed.nth) return;
  const receipt = { point: name, hit: armed.hits, pid: process.pid, at: new Date().toISOString() };
  if (armed.receiptPath) {
    try { appendFileSync(armed.receiptPath, `${JSON.stringify(receipt)}\n`); } catch { /* the log line still records it */ }
  }
  try { process.stderr.write(`[crash-point] SIGKILL ${JSON.stringify(receipt)}\n`); } catch { /* ignore */ }
  process.kill(process.pid, "SIGKILL");
}

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
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type RunnerCrashPointName =
  | "runner.process.after_spawn_before_identity"
  | "runner.turn_start.after_runner_accept_before_controller_checkpoint"
  | "runner.turn_start.after_controller_journal_before_db_checkpoint";

type Armed = {
  name: string; nth: number; hits: number; receiptPath: string | null; gatePath: string | null;
  /** Runtime arming (PAPERCLIP_CRASH_POINT_CONTROL): read "<token> <name>[:<nth>]" at each hit. */
  controlPath: string | null; token: string | null;
};

function parseSpec(raw: string): { name: string; nth: number } | null {
  const separator = raw.lastIndexOf(":");
  const name = separator === -1 ? raw : raw.slice(0, separator);
  const nth = separator === -1 ? 1 : Number(raw.slice(separator + 1));
  return name && Number.isInteger(nth) && nth >= 1 ? { name, nth } : null;
}

function armFromEnvironment(): Armed | null {
  const env = typeof process === "undefined" ? undefined : process.env;
  if (!env || env.NODE_ENV === "production") return null;
  const receiptPath = env.PAPERCLIP_CRASH_POINT_RECEIPT?.trim() || null;
  const controlPath = env.PAPERCLIP_CRASH_POINT_CONTROL?.trim() || null;
  if (controlPath) return { name: "", nth: 1, hits: 0, receiptPath, gatePath: null, controlPath, token: null };
  const raw = env.PAPERCLIP_CRASH_POINT?.trim();
  if (!raw) return null;
  const spec = parseSpec(raw);
  // The shared helper validates the name; this copy only arms its own names.
  if (!spec || !spec.name.startsWith("runner.")) return null;
  return { ...spec, hits: 0, receiptPath, gatePath: env.PAPERCLIP_CRASH_POINT_GATE?.trim() || null, controlPath: null, token: null };
}

const armed: Armed | null = armFromEnvironment();

function readControl(current: Armed): boolean {
  let text: string;
  try { text = readFileSync(current.controlPath!, "utf8"); } catch { return false; }
  const [token, raw, ...rest] = text.trim().split(/\s+/);
  const spec = token && raw && rest.length === 0 ? parseSpec(raw) : null;
  if (!token || !spec) return false;
  if (token !== current.token) Object.assign(current, { token, name: spec.name, nth: spec.nth, hits: 0 });
  return true;
}

export function crashPoint(name: RunnerCrashPointName): void {
  if (armed === null) return;
  if (armed.controlPath && !readControl(armed)) return;
  if (armed.name !== name) return;
  if (armed.gatePath !== null) {
    if (!existsSync(armed.gatePath)) return;
    armed.gatePath = null;
  }
  armed.hits += 1;
  if (armed.hits !== armed.nth) return;
  const receipt = { point: name, hit: armed.hits, pid: process.pid, at: new Date().toISOString(),
    ...(armed.token ? { token: armed.token } : {}) };
  if (armed.receiptPath) {
    try { appendFileSync(armed.receiptPath, `${JSON.stringify(receipt)}\n`); } catch { /* the log line still records it */ }
  }
  try { process.stderr.write(`[crash-point] SIGKILL ${JSON.stringify(receipt)}\n`); } catch { /* ignore */ }
  process.kill(process.pid, "SIGKILL");
}

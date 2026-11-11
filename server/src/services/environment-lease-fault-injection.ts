/**
 * Restart-chaos fault EP1 (tests/restart-chaos/env-provider-faults.ts): make a
 * run's lease acquisition fail before any provider call, in the exact shapes
 * staging recorded, so the bounded retry and Retry paths can be exercised on a
 * local instance without a paid sandbox provider.
 *
 * Arming (test mode only; ignored when NODE_ENV=production):
 *
 *   PAPERCLIP_CHAOS_LEASE_FAULT_CONTROL=<file>
 *
 * Each acquisition reads the file. Missing, empty or malformed means disarmed.
 * Content: {"token":"<id>","kind":"timeout"|"database","failures":<n>|null}.
 * The first <n> acquisitions of each task under one token fail (null: every
 * one), so writing a new token re-arms with fresh counts and an empty file
 * disarms. Counts live in this process, so a restart starts them again.
 *
 * This is test instrumentation, not Telemetry or Observability
 * (rules/data-paths.mdc): nothing is recorded or sent anywhere.
 */
import { readFileSync } from "node:fs";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, readEnvironmentAcquisitionDiagnostic } from "@paperclipai/plugin-sdk";
import { captureEnvironmentAcquisitionDiagnostic } from "./environment-acquisition-diagnostics.js";

export const LEASE_FAULT_CONTROL_ENV = "PAPERCLIP_CHAOS_LEASE_FAULT_CONTROL";

export type LeaseFaultControl = { token: string; kind: "timeout" | "database"; failures: number | null };

export function parseLeaseFaultControl(text: string): LeaseFaultControl | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.token !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.token)) return null;
    if (value.kind !== "timeout" && value.kind !== "database") return null;
    const failures = value.failures;
    if (failures !== null && !(Number.isSafeInteger(failures) && (failures as number) >= 0)) return null;
    return { token: value.token, kind: value.kind, failures: failures as number | null };
  } catch { return null; }
}

const controlPath = process.env.NODE_ENV === "production" ? null : process.env[LEASE_FAULT_CONTROL_ENV]?.trim() || null;
const counts = new Map<string, number>();

/** The staging shapes: Daytona's acquisition deadline, and a failed control-plane query. */
export function leaseFaultError(kind: LeaseFaultControl["kind"], input: {
  companyId: string; environmentId: string; heartbeatRunId: string;
}): Error {
  if (kind === "database") {
    return new Error("Failed query: insert into \"environment_leases\" (\"id\") values ($1)\nparams: <chaos>", {
      cause: Object.assign(new Error("terminating connection due to administrator command"), { name: "PostgresError", code: "57P01" }),
    });
  }
  const error = new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
    message: "Daytona lease acquisition timed out; allocation cleanup is pending",
    data: { schema: "paperclip/environment-creation-cleanup/v1",
      cleanup: { providerLeaseId: `chaos-ep1-${input.heartbeatRunId.slice(0, 8)}`, companyId: input.companyId,
        environmentId: input.environmentId, runId: input.heartbeatRunId, attemptId: input.heartbeatRunId,
        accountFingerprint: "0".repeat(64), labels: {} },
      acquisitionDiagnostic: { phase: "create", elapsedMs: 300_000, budgetMs: 300_000, providerState: "creating" } } });
  captureEnvironmentAcquisitionDiagnostic(error, { companyId: input.companyId, environmentId: input.environmentId,
    runId: input.heartbeatRunId }, readEnvironmentAcquisitionDiagnostic(error));
  return error;
}

/** Throws the armed fault for this acquisition; a single null check when disarmed. */
export function injectLeaseAcquisitionFault(input: {
  companyId: string; environmentId: string; heartbeatRunId: string; issueId: string | null;
}): void {
  if (controlPath === null || !input.issueId) return;
  let control: LeaseFaultControl | null;
  try { control = parseLeaseFaultControl(readFileSync(controlPath, "utf8")); } catch { return; }
  if (!control) return;
  const key = `${control.token}:${input.issueId}`;
  const seen = counts.get(key) ?? 0;
  if (control.failures !== null && seen >= control.failures) return;
  counts.set(key, seen + 1);
  throw leaseFaultError(control.kind, input);
}

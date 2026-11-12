/**
 * `--fail-recovery-step <step>[:<nth>]`: fail the Nth attempt of one recovery step once (README "Fail the Nth
 * recovery step").
 *
 * Every other fault hits the control plane once and then lets recovery run. On staging the first fault was
 * often harmless and a later recovery step failed: the retry of a bootstrap met a missing runtime asset, a
 * reattach met `Agent directory operation is already active`, a bounded retry met an unfinished teardown.
 * This option lets the wave's first restart fault fire normally. When that fault's replacement server
 * starts, the harness arms one crash point in fail mode (`packages/shared/src/crash-points.ts`): the nth hit
 * of the point in the replacement throws the error its real step throws, once. nth = 1 fails recovery's
 * first attempt at the step, 2 its second, and so on, so recovery chains are exercised.
 *
 * Hits count across the whole server: with several tasks in flight, the nth hit may belong to any of them.
 * Run one task per wave (`--tasks 1 --concurrency 1`) to aim at one task's nth attempt.
 */
import { CRASH_POINTS, isCrashPointName, type CrashPointName } from "../../packages/shared/src/crash-point-registry.js";
import { noFailedAttemptCheck } from "./rewake.js";
import type { EnvironmentKind, FaultKind, OracleResult } from "./types.js";

/** Short names for the steps staging failed at; any registered crash point name is also accepted. */
export const RECOVERY_STEPS: Record<string, CrashPointName> = {
  // A runnerd start that fails before the process exists (spawn EAGAIN), local and Daytona.
  "runnerd-start": "native.process_start.after_requested_before_spawn",
  // A sandbox teardown whose provider destroy did not finish (Daytona).
  teardown: "environment.teardown.after_claim_before_destroy",
  // The agent-directory lock still held by another operation (Daytona): staging class A's terminal error.
  "directory-lock": "agent_directory.operation_lock.before_acquire",
};

/** Restart faults whose replacement start arms the step. */
export const RECOVERY_STEP_FAULTS: readonly FaultKind[] = ["K1", "K2", "K4", "K6", "K14", "K15", "RR1", "RR2", "RR3"];

export interface RecoveryStepSpec { point: CrashPointName; nth: number }

export function parseRecoveryStep(raw: string): RecoveryStepSpec {
  const match = /^([a-z0-9_.-]+)(?::([1-9][0-9]?))?$/.exec(raw.trim());
  if (!match) throw new Error("--fail-recovery-step takes <step>[:<nth>], for example directory-lock:2");
  const point = RECOVERY_STEPS[match[1]!] ?? match[1]!;
  if (!isCrashPointName(point)) {
    throw new Error(`--fail-recovery-step: unknown step "${match[1]}"; use ${Object.keys(RECOVERY_STEPS).join(", ")} or a crash point name`);
  }
  return { point, nth: match[2] ? Number(match[2]) : 1 };
}

/** The control-file spec the supervisor writes: "<name>:<nth> fail". */
export function recoveryStepControlSpec(spec: RecoveryStepSpec): string {
  return `${spec.point}:${spec.nth} fail`;
}

export function validateRecoveryStep(options: { env: EnvironmentKind; faults: readonly string[]; crashPoint?: string; stormMinutes?: number },
  raw: string | undefined): { failRecoveryStep?: string } {
  if (raw === undefined) return {};
  const spec = parseRecoveryStep(raw);
  if (options.crashPoint) throw new Error("--fail-recovery-step arms its own point; do not combine it with --crash-point");
  if (!options.faults.some(fault => RECOVERY_STEP_FAULTS.includes(fault as FaultKind))) {
    throw new Error(`--fail-recovery-step fails a step of the recovery after a restart; add one of ${RECOVERY_STEP_FAULTS.join(", ")} to --faults`);
  }
  const environments = CRASH_POINTS[spec.point].environments as readonly string[];
  if (!environments.includes(options.env)) {
    throw new Error(`--fail-recovery-step ${spec.point} is reached only with --env ${environments.join(" or ")}`);
  }
  return { failRecoveryStep: `${spec.point}:${spec.nth}` };
}

export interface RecoveryStepHit { point: string; hit: number; pid: number; token?: string; mode?: string; at?: string }

/** Every fail-mode receipt the server appended. */
export function parseRecoveryStepReceipts(text: string): RecoveryStepHit[] {
  return text.split("\n").flatMap(line => {
    try {
      const parsed = JSON.parse(line) as RecoveryStepHit;
      return parsed.mode === "fail" && typeof parsed.point === "string" ? [parsed] : [];
    } catch { return []; }
  });
}

/**
 * The task's checks, added to every task the armed fault crossed: the armed step failed in the replacement (else
 * the cell tested nothing), and recovery absorbed it: no attempt of the task failed.
 */
export function withRecoveryStepCheck(oracle: OracleResult, armed: { faultId: string; spec: string; token: string } | null,
  taskFaultIds: readonly string[], hits: readonly RecoveryStepHit[],
  runs: ReadonlyArray<{ id: string; status: string; errorCode: string | null }>): OracleResult {
  if (!armed || !taskFaultIds.includes(armed.faultId)) return oracle;
  const hit = hits.find(entry => entry.token === armed.token);
  const checks = [...oracle.checks, { name: "recovery_step_failed_once", ok: Boolean(hit),
    detail: hit ? `${hit.point} hit ${hit.hit} failed at ${hit.at ?? "?"} after ${armed.faultId}` : `${armed.spec} never reached after ${armed.faultId}` },
  ...(oracle.checks.some(check => check.name === "no_failed_attempt") ? [] : [noFailedAttemptCheck(runs)])];
  return { ...oracle, checks, verdict: checks.every(check => check.ok) ? "pass" : "fail" };
}

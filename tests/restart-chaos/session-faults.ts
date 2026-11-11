/**
 * Session faults (SR1): the agent's saved provider session is replaced while a
 * warm owner of the same task is still retained. Nothing restarts.
 *
 * SR1 runs with the Q1 workload. After the asking run parks on its saved
 * question and settles, the board changes the agent's adapter configuration
 * through the agent route a user would use. The answer then wakes a follow-up
 * that cannot resume the saved session, so it must retire the parked owner
 * (whose question callback is still unsettled) before it starts a new one.
 * The retirement must not fail the follow-up: Q1's `no_failed_attempt` and
 * `issue_done` checks are the oracle. Two Q1 tasks on the same agent are the
 * two-concurrent-runs variant: one change rotates both tasks' sessions.
 *
 * SR1U is the variant where that owner cannot be retired at all: the server
 * is booted with a test-only fault that leaves every warm sandbox owner's stop
 * unconfirmed, even when forced. The follow-up must then drop the reused
 * sandbox and finish on a fresh one restored from the saved workspace. Its
 * one allowed failed attempt is the pre-provider fallback itself.
 */
import type { ChaosApi } from "./api.js";
import type { WorkloadId } from "./types.js";

export const SESSION_FAULT_KINDS = ["SR1", "SR1U"] as const;
export type SessionFaultKind = (typeof SESSION_FAULT_KINDS)[number];
export const SESSION_FAULT_WORKLOADS: readonly WorkloadId[] = ["Q1"];

/** The pre-provider failure that sends the next attempt to a fresh sandbox. */
export const PREDECESSOR_RETIREMENT_UNPROVEN_CAUSE = "native_predecessor_retirement_unproven";

export function isSessionFault(value: string): value is SessionFaultKind {
  return (SESSION_FAULT_KINDS as readonly string[]).includes(value);
}

/** Server environment a wave of these faults needs. It applies to the whole server. */
export function sessionFaultServerEnvironment(faults: readonly SessionFaultKind[] | undefined): Record<string, string> {
  return faults?.includes("SR1U") ? { PAPERCLIP_TEST_WARM_RETIREMENT_FAULT: "unconfirmed" } : {};
}

/** What the board changed, recorded on the task's question. */
export interface SessionRotation {
  at: number;
  idleTimeoutMs: number;
  httpStatus: number | null;
  error: string | null;
  /** SR1U: the retained owner cannot be retired; the follow-up must move to a fresh sandbox. */
  predecessorUnretirable?: boolean;
}

/**
 * Change one adapter setting that is part of the session's configuration
 * fingerprint and is harmless to the run: the warm idle window, by a few
 * milliseconds unique to this task.
 */
export async function rotateAgentSession(api: Pick<ChaosApi, "patch">, agentId: string, taskIndex: number, now: number,
  fault: SessionFaultKind = "SR1"): Promise<SessionRotation> {
  const idleTimeoutMs = 300_000 + 1 + taskIndex;
  const rotation: SessionRotation = { at: now, idleTimeoutMs, httpStatus: null, error: null,
    ...(fault === "SR1U" ? { predecessorUnretirable: true } : {}) };
  try {
    await api.patch(`/api/agents/${agentId}`, { adapterConfig: { idleTimeoutMs } });
    rotation.httpStatus = 200;
  } catch (error) {
    rotation.httpStatus = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
    rotation.error = error instanceof Error ? error.message : String(error);
  }
  return rotation;
}

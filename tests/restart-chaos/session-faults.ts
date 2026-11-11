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
 */
import type { ChaosApi } from "./api.js";
import type { WorkloadId } from "./types.js";

export const SESSION_FAULT_KINDS = ["SR1"] as const;
export type SessionFaultKind = (typeof SESSION_FAULT_KINDS)[number];
export const SESSION_FAULT_WORKLOADS: readonly WorkloadId[] = ["Q1"];

export function isSessionFault(value: string): value is SessionFaultKind {
  return (SESSION_FAULT_KINDS as readonly string[]).includes(value);
}

/** What the board changed, recorded on the task's question. */
export interface SessionRotation {
  at: number;
  idleTimeoutMs: number;
  httpStatus: number | null;
  error: string | null;
}

/**
 * Change one adapter setting that is part of the session's configuration
 * fingerprint and is harmless to the run: the warm idle window, by a few
 * milliseconds unique to this task.
 */
export async function rotateAgentSession(api: Pick<ChaosApi, "patch">, agentId: string, taskIndex: number, now: number): Promise<SessionRotation> {
  const idleTimeoutMs = 300_000 + 1 + taskIndex;
  const rotation: SessionRotation = { at: now, idleTimeoutMs, httpStatus: null, error: null };
  try {
    await api.patch(`/api/agents/${agentId}`, { adapterConfig: { idleTimeoutMs } });
    rotation.httpStatus = 200;
  } catch (error) {
    rotation.httpStatus = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
    rotation.error = error instanceof Error ? error.message : String(error);
  }
  return rotation;
}

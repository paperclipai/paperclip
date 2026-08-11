import { readObject } from "../lib/objects.js";

const MAX_SUPERVISION_WINDOW_MS = 2 * 60 * 60 * 1000;

type AgentAdmissionSubject = {
  adapterType: string;
  runtimeConfig?: unknown;
};

export type ControlledAgentAdmission =
  | {
      mode: "issue";
      reason: string;
      issueId?: string;
      taskId?: string;
      taskKey?: string;
    }
  | {
      mode: "supervision";
      reason: string;
      expiresAt: string;
    };

export type ControlledAgentAdmissionResult =
  | { ok: true; admission: ControlledAgentAdmission | null }
  | { ok: false; error: string; code: "CONTROLLED_ADMISSION_REQUIRED" };

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * manualOnlyAdmission protects model dispatch, but a stale board controller
 * could still widen the idle/eligible fleet by calling the generic resume
 * endpoint. Require every such resume to carry a short-lived, auditable scope.
 * Deterministic shell handlers and ordinary agents keep their existing API.
 */
export function validateControlledAgentAdmission(
  agent: AgentAdmissionSubject,
  body: unknown,
  now = new Date(),
): ControlledAgentAdmissionResult {
  const runtimeConfig = readObject(agent.runtimeConfig) ?? {};
  if (agent.adapterType === "paperclip_shell_handler" || runtimeConfig.manualOnlyAdmission !== true) {
    return { ok: true, admission: null };
  }

  const admission = readObject((readObject(body) ?? {}).controlledAdmission);
  const mode = nonEmptyString(admission?.mode);
  const reason = nonEmptyString(admission?.reason);
  if (!admission || !reason || (mode !== "issue" && mode !== "supervision")) {
    return {
      ok: false,
      code: "CONTROLLED_ADMISSION_REQUIRED",
      error: "manualOnlyAdmission agents require controlledAdmission with mode and reason before resume",
    };
  }

  if (mode === "issue") {
    const issueId = nonEmptyString(admission.issueId) ?? undefined;
    const taskId = nonEmptyString(admission.taskId) ?? undefined;
    const taskKey = nonEmptyString(admission.taskKey) ?? undefined;
    if (!issueId && !taskId && !taskKey) {
      return {
        ok: false,
        code: "CONTROLLED_ADMISSION_REQUIRED",
        error: "controlledAdmission mode issue requires issueId, taskId, or taskKey",
      };
    }
    return { ok: true, admission: { mode, reason, issueId, taskId, taskKey } };
  }

  const expiresAt = nonEmptyString(admission.expiresAt);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const nowMs = now.getTime();
  if (!expiresAt || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs > nowMs + MAX_SUPERVISION_WINDOW_MS) {
    return {
      ok: false,
      code: "CONTROLLED_ADMISSION_REQUIRED",
      error: "controlledAdmission mode supervision requires an expiresAt within the next two hours",
    };
  }
  return { ok: true, admission: { mode, reason, expiresAt: new Date(expiresAtMs).toISOString() } };
}

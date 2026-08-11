import { readObject } from "../lib/objects.js";

type AgentAdmissionSubject = {
  adapterType: string;
  adapterConfig?: unknown;
  runtimeConfig?: unknown;
};

export const MAX_CONTROLLED_AGENT_DESIRED_SKILLS = 16;

export type ControlledAgentAdmission = {
  mode: "issue";
  reason: string;
  issueId?: string;
  taskId?: string;
  taskKey?: string;
};

export type ControlledAgentAdmissionResult =
  | { ok: true; admission: ControlledAgentAdmission | null }
  | {
      ok: false;
      error: string;
      code: "CONTROLLED_ADMISSION_REQUIRED" | "CONTROLLED_SKILL_SCOPE_TOO_BROAD";
      details?: Record<string, unknown>;
    };

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function validateControlledAgentSkillScope(agent: AgentAdmissionSubject): ControlledAgentAdmissionResult {
  const runtimeConfig = readObject(agent.runtimeConfig) ?? {};
  if (agent.adapterType === "paperclip_shell_handler" || runtimeConfig.manualOnlyAdmission !== true) {
    return { ok: true, admission: null };
  }
  const adapterConfig = readObject(agent.adapterConfig) ?? {};
  const syncConfig = readObject(adapterConfig.paperclipSkillSync) ?? {};
  const desiredSkills = Array.isArray(syncConfig.desiredSkills) ? syncConfig.desiredSkills : [];
  const skillKeys = new Set(desiredSkills.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim()];
    const record = readObject(entry);
    return typeof record?.key === "string" && record.key.trim() ? [record.key.trim()] : [];
  }));
  if (skillKeys.size > MAX_CONTROLLED_AGENT_DESIRED_SKILLS) {
    return {
      ok: false,
      code: "CONTROLLED_SKILL_SCOPE_TOO_BROAD",
      error: `manualOnlyAdmission agents may declare at most ${MAX_CONTROLLED_AGENT_DESIRED_SKILLS} desired skills before resume or dispatch`,
      details: { desiredSkillCount: skillKeys.size, maxDesiredSkills: MAX_CONTROLLED_AGENT_DESIRED_SKILLS },
    };
  }
  return { ok: true, admission: null };
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
): ControlledAgentAdmissionResult {
  const runtimeConfig = readObject(agent.runtimeConfig) ?? {};
  if (agent.adapterType === "paperclip_shell_handler" || runtimeConfig.manualOnlyAdmission !== true) {
    return { ok: true, admission: null };
  }

  const skillScope = validateControlledAgentSkillScope(agent);
  if (!skillScope.ok) return skillScope;

  const admission = readObject((readObject(body) ?? {}).controlledAdmission);
  const mode = nonEmptyString(admission?.mode);
  const reason = nonEmptyString(admission?.reason);
  if (!admission || !reason || mode !== "issue") {
    return {
      ok: false,
      code: "CONTROLLED_ADMISSION_REQUIRED",
      error: "manualOnlyAdmission agents require an issue-bound controlledAdmission with mode and reason before resume",
    };
  }

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

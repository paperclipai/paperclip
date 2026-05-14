import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";
import { redactSensitiveText } from "../redaction.js";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";

type ApprovalRecord = typeof approvals.$inferSelect;

type AgentOsApplyStatus = "skipped" | "succeeded" | "failed";

type AgentOsApplyRecord = {
  source: "agent_os_apply_service";
  version: 1;
  status: AgentOsApplyStatus;
  action: string;
  approvalId: string;
  idempotencyKey: string;
  liveExternalActions: false;
  startedAt: string;
  completedAt: string;
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
};

type AgentOsBlueprintPayload = {
  key: string;
  title: string;
  category?: string;
  requiredSkillRefs?: string[];
  mcpBundleRefs?: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readBlueprint(payload: Record<string, unknown>): AgentOsBlueprintPayload | null {
  const blueprint = asRecord(payload.blueprint);
  if (!blueprint) return null;
  const key = typeof blueprint.key === "string" ? blueprint.key.trim() : "";
  const title = typeof blueprint.title === "string" ? blueprint.title.trim() : "";
  if (!key || !title) return null;
  return {
    key,
    title,
    category: typeof blueprint.category === "string" && blueprint.category.trim() ? blueprint.category.trim() : undefined,
    requiredSkillRefs: asStringArray(blueprint.requiredSkillRefs),
    mcpBundleRefs: asStringArray(blueprint.mcpBundleRefs),
  };
}

function getExistingAgentOsApply(payload: Record<string, unknown>): AgentOsApplyRecord | null {
  const existing = asRecord(payload.agentOsApply);
  if (!existing) return null;
  if (existing.source !== "agent_os_apply_service") return null;
  if (existing.version !== 1) return null;
  const status = existing.status;
  if (status !== "skipped" && status !== "succeeded" && status !== "failed") return null;
  if (typeof existing.action !== "string") return null;
  if (typeof existing.approvalId !== "string") return null;
  if (typeof existing.idempotencyKey !== "string") return null;
  if (typeof existing.startedAt !== "string" || typeof existing.completedAt !== "string") return null;
  const record: AgentOsApplyRecord = {
    source: "agent_os_apply_service",
    version: 1,
    status,
    action: existing.action,
    approvalId: existing.approvalId,
    idempotencyKey: existing.idempotencyKey,
    liveExternalActions: false,
    startedAt: existing.startedAt,
    completedAt: existing.completedAt,
  };
  const result = asRecord(existing.result);
  if (result) record.result = result;
  if (typeof existing.errorCode === "string") record.errorCode = existing.errorCode;
  if (typeof existing.errorMessage === "string") record.errorMessage = existing.errorMessage;
  return record;
}

function buildApplyRecord(
  approval: ApprovalRecord,
  payload: Record<string, unknown>,
  status: AgentOsApplyStatus,
  startedAt: string,
  fields: Pick<AgentOsApplyRecord, "result" | "errorCode" | "errorMessage"> = {},
): AgentOsApplyRecord {
  const completedAt = new Date().toISOString();
  const action = typeof payload.action === "string" ? payload.action : "unknown";
  return {
    source: "agent_os_apply_service",
    version: 1,
    status,
    action,
    approvalId: approval.id,
    idempotencyKey: `agent_os:${approval.id}:${action}`,
    liveExternalActions: false,
    startedAt,
    completedAt,
    ...fields,
  };
}

function shouldApplyAgentOsPayload(payload: Record<string, unknown>): boolean {
  return (
    payload.surface === "agent_os" &&
    payload.liveApply === true &&
    payload.approvalOnly === false &&
    payload.liveExecution === false &&
    payload.liveExternalActions === false
  );
}

function safeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown";
  return redactSensitiveText(raw).trim() || "unknown";
}

export function stripAgentOsApplyState<T extends Pick<ApprovalRecord, "payload">>(approval: T): T {
  const payload = asRecord(approval.payload);
  if (!payload || !("agentOsApply" in payload)) return approval;
  const { agentOsApply: _agentOsApply, ...payloadWithoutApply } = payload;
  return { ...approval, payload: payloadWithoutApply };
}

export function hasCompletedAgentOsApplyRecord(approval: Pick<ApprovalRecord, "id" | "payload">): boolean {
  return Boolean(getTrustedExistingAgentOsApply(approval));
}

function getTrustedExistingAgentOsApply(approval: Pick<ApprovalRecord, "id" | "payload">): AgentOsApplyRecord | null {
  const payload = asRecord(approval.payload);
  if (!payload) return null;
  const existingApply = getExistingAgentOsApply(payload);
  if (!existingApply || existingApply.approvalId !== approval.id) return null;
  const expectedAction = typeof payload.action === "string" ? payload.action : existingApply.action;
  if (existingApply.action !== expectedAction) return null;
  if (existingApply.idempotencyKey !== `agent_os:${approval.id}:${existingApply.action}`) return null;
  return existingApply;
}

function normalizeApprovalForApply<T extends Pick<ApprovalRecord, "id" | "payload">>(approval: T): T {
  return getTrustedExistingAgentOsApply(approval) ? approval : stripAgentOsApplyState(approval);
}

async function persistApplyRecord(db: Db, approval: ApprovalRecord, actorUserId: string, apply: AgentOsApplyRecord) {
  const strippedApproval = stripAgentOsApplyState(approval);
  const payload = { ...(strippedApproval.payload as Record<string, unknown>), agentOsApply: apply };
  const updatedApproval = await db
    .update(approvals)
    .set({ payload, updatedAt: new Date() })
    .where(eq(approvals.id, approval.id))
    .returning()
    .then((rows) => rows[0] ?? { ...approval, payload });

  const result = asRecord(apply.result);
  const agentId = typeof result?.agentId === "string" ? result.agentId : null;
  await logActivity(db, {
    companyId: approval.companyId,
    actorType: "user",
    actorId: actorUserId,
    action: `agent_os_apply_${apply.status}`,
    entityType: "approval",
    entityId: approval.id,
    agentId,
    details: {
      version: apply.version,
      status: apply.status,
      action: apply.action,
      approvalId: apply.approvalId,
      idempotencyKey: apply.idempotencyKey,
      liveExternalActions: apply.liveExternalActions,
      result: apply.result ?? null,
      errorCode: apply.errorCode ?? null,
      errorMessage: apply.errorMessage ?? null,
    },
  }).catch((error: unknown) => {
    console.error("[agent-os-apply] audit log write failed", {
      approvalId: approval.id,
      action: apply.action,
      status: apply.status,
      error: safeErrorMessage(error),
    });
  });

  return { approval: updatedApproval, apply };
}

function findExistingProvisionedAgent(
  rows: Array<{ id: string; name: string; status?: string | null; metadata?: Record<string, unknown> | null }>,
  blueprint: AgentOsBlueprintPayload,
) {
  return rows.find((agent) => {
    if (agent.status === "terminated") return false;
    const metadata = asRecord(agent.metadata);
    const agentOs = metadata ? asRecord(metadata.agentOs) : null;
    return agentOs?.blueprintKey === blueprint.key;
  }) ?? null;
}

export function isAgentOsApplyApproval(approval: Pick<ApprovalRecord, "type" | "payload">): boolean {
  const payload = asRecord(approval.payload);
  return Boolean(
    approval.type === "request_board_approval" &&
      payload &&
      payload.surface === "agent_os" &&
      payload.liveApply === true &&
      payload.approvalOnly !== true,
  );
}

export function agentOsApprovalApplyService(db: Db) {
  const agentsSvc = agentService(db);

  return {
    async applyApprovedApproval(approval: ApprovalRecord, decidedByUserId: string) {
      const applyApproval = normalizeApprovalForApply(approval);
      const payload = asRecord(applyApproval.payload) ?? {};
      const existingApply = getTrustedExistingAgentOsApply(applyApproval);
      if (existingApply) {
        return { approval: applyApproval, apply: existingApply };
      }

      const startedAt = new Date().toISOString();
      if (applyApproval.status !== "approved") {
        return persistApplyRecord(
          db,
          applyApproval,
          decidedByUserId,
          buildApplyRecord(applyApproval, payload, "skipped", startedAt, {
            errorCode: "approval_not_approved",
            errorMessage: "Agent OS apply requires an approved approval record.",
          }),
        );
      }
      if (!shouldApplyAgentOsPayload(payload)) {
        return persistApplyRecord(
          db,
          applyApproval,
          decidedByUserId,
          buildApplyRecord(applyApproval, payload, "skipped", startedAt, {
            errorCode: "live_apply_not_requested",
            errorMessage: "Approval payload is preview-only or permits live external actions, so no live apply was executed.",
          }),
        );
      }

      if (payload.action !== "ready_agent_provision_preview" || payload.approvalScope !== "ready_agent_provisioning") {
        return persistApplyRecord(
          db,
          applyApproval,
          decidedByUserId,
          buildApplyRecord(applyApproval, payload, "failed", startedAt, {
            errorCode: "unsupported_agent_os_action",
            errorMessage: "This Agent OS action is not wired to a live apply executor yet.",
          }),
        );
      }

      const blueprint = readBlueprint(payload);
      if (!blueprint) {
        return persistApplyRecord(
          db,
          applyApproval,
          decidedByUserId,
          buildApplyRecord(applyApproval, payload, "failed", startedAt, {
            errorCode: "invalid_ready_agent_blueprint",
            errorMessage: "Ready-agent provisioning requires a blueprint with key and title.",
          }),
        );
      }

      try {
        const existingAgents = await agentsSvc.list(applyApproval.companyId);
        const existingAgent = findExistingProvisionedAgent(existingAgents, blueprint);
        if (existingAgent) {
          return persistApplyRecord(
            db,
            applyApproval,
            decidedByUserId,
            buildApplyRecord(applyApproval, payload, "succeeded", startedAt, {
              result: {
                agentId: existingAgent.id,
                agentName: existingAgent.name,
                blueprintKey: blueprint.key,
                reusedExisting: true,
              },
            }),
          );
        }

        const created = await agentsSvc.create(applyApproval.companyId, {
          name: blueprint.title,
          role: blueprint.category ?? "general",
          title: blueprint.title,
          capabilities: blueprint.requiredSkillRefs?.length
            ? `Agent OS ready-agent blueprint. Skills: ${blueprint.requiredSkillRefs.join(", ")}`
            : "Agent OS ready-agent blueprint.",
          adapterType: "hermes_local",
          adapterConfig: {},
          runtimeConfig: {},
          status: "idle",
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          permissions: {},
          metadata: {
            agentOs: {
              version: 1,
              source: "agent_os_apply_engine",
              approvalId: applyApproval.id,
              blueprintKey: blueprint.key,
              mcpBundleRefs: blueprint.mcpBundleRefs ?? [],
              requiredSkillRefs: blueprint.requiredSkillRefs ?? [],
              provisionedByUserId: decidedByUserId,
            },
          },
        });

        return persistApplyRecord(
          db,
          applyApproval,
          decidedByUserId,
          buildApplyRecord(applyApproval, payload, "succeeded", startedAt, {
            result: {
              agentId: created.id,
              agentName: created.name,
              blueprintKey: blueprint.key,
              reusedExisting: false,
            },
          }),
        );
      } catch (error) {
        const errorMessage = safeErrorMessage(error);
        console.error("[agent-os-apply] executor failed", {
          approvalId: applyApproval.id,
          action: typeof payload.action === "string" ? payload.action : "unknown",
          error: errorMessage,
        });
        return persistApplyRecord(
          db,
          applyApproval,
          decidedByUserId,
          buildApplyRecord(applyApproval, payload, "failed", startedAt, {
            errorCode: "live_apply_executor_failed",
            errorMessage: "Ready-agent provisioning executor failed before completion.",
          }),
        );
      }
    },
  };
}

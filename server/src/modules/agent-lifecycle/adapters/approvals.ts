import { agentAppearanceSchema } from "@paperclipai/shared";

import type { Db } from "@paperclipai/db";

import { unprocessable } from "../../../errors.js";

import { agentRecords as agentService } from "./records.js";
import type { LifecycleEffects } from "./effects.js";

import { approvalResolutionRecords } from "../../../lib/approval-records.js";

export function hireApprovalService(db: Db, effects: LifecycleEffects) {
  const { getExistingApproval, resolveApproval } = approvalResolutionRecords(db);

  return {
    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type !== "hire_agent") throw unprocessable("Expected a hire approval");
      // Receipt writers lock company before agent. Hire approval must use that
      // order too, including activation of an existing pending agent.
      const result = await effects.transaction(db, existing.companyId, async (txDb, publications) => {
        const agentsSvc = agentService(txDb, effects);
        const { approval: updated, applied } = await resolveApproval(
          id,
          "approved",
          decidedByUserId,
          decisionNote,
          txDb,
        );

        let hireApprovedAgentId: string | null = null;
        if (applied && updated.type === "hire_agent") {
          const payload = updated.payload as Record<string, unknown>;
          const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
          if (payloadAgentId) {
            await agentsSvc.activatePendingApproval(payloadAgentId, payload, updated.requestedByUserId);
            hireApprovedAgentId = payloadAgentId;
          } else {
            const created = await agentsSvc.create(updated.companyId, {
              name: String(payload.name ?? "New Agent"),
              appearance: payload.appearance == null ? undefined : agentAppearanceSchema.parse(payload.appearance),
              role: String(payload.role ?? "general"),
              title: typeof payload.title === "string" ? payload.title : null,
              reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
              capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
              adapterType: String(payload.adapterType ?? "process"),
              adapterConfig:
                typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                  ? (payload.adapterConfig as Record<string, unknown>)
                  : {},
              budgetMonthlyCents:
                typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
              metadata:
                typeof payload.metadata === "object" && payload.metadata !== null
                  ? (payload.metadata as Record<string, unknown>)
                  : null,
              status: "idle",
              spentMonthlyCents: 0,
              permissions: undefined,
              lastHeartbeatAt: null,
            }, { createdByUserId: updated.requestedByAgentId ? null : updated.requestedByUserId, responsibleUserId: updated.requestedByUserId });
            hireApprovedAgentId = created?.id ?? null;
          }
          if (hireApprovedAgentId) {
            const budgetMonthlyCents =
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
            if (budgetMonthlyCents > 0) {
              await effects.setAgentBudget(txDb, publications, updated.companyId, hireApprovedAgentId,
                budgetMonthlyCents, decidedByUserId);
            }

          }
        }

        return { approval: updated, applied, hireApprovedAgentId };
      });
      return result;
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.type !== "hire_agent") throw unprocessable("Expected a hire approval");
      return effects.transaction(db, existing.companyId, async tx => {
        const txDb = tx as unknown as Db;
        const { approval: updated, applied } = await resolveApproval(
          id,
          "rejected",
          decidedByUserId,
          decisionNote,
          txDb,
        );

        if (applied && updated.type === "hire_agent") {
          const payload = updated.payload as Record<string, unknown>;
          const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
          if (payloadAgentId) {
            await agentService(txDb, effects).rejectPendingHire(payloadAgentId);
          }
        }

        return { approval: updated, applied };
      });
    },

  };
}

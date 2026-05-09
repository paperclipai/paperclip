import { and, eq, isNull, or } from "drizzle-orm";
import { agentContracts } from "@paperclipai/db";
import type { AgentContractSummary, AutonomyEvidenceType } from "@paperclipai/shared";
import type { AutonomyKernelContext, PreflightRunRequest } from "./types.js";

export interface ContractEvaluation {
  status: "allow" | "deny" | "approval_required";
  reason: string | null;
  contract: AgentContractSummary | null;
  requiresApprovalFor: string[];
}

type ContractRow = typeof agentContracts.$inferSelect;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toContractDto(row: ContractRow): AgentContractSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    laneKey: row.laneKey ?? null,
    name: row.name,
    version: row.version,
    status: row.status as AgentContractSummary["status"],
    allowedIssueTypes: row.allowedIssueTypes,
    requiredEvidenceTypes: row.requiredEvidenceTypes as AutonomyEvidenceType[],
    allowedEvidenceTypes: row.allowedEvidenceTypes as AutonomyEvidenceType[],
    requiresApprovalFor: row.requiresApprovalFor,
    maxRunDurationSeconds: row.maxRunDurationSeconds ?? null,
    activatedAt: toIso(row.activatedAt),
    retiredAt: toIso(row.retiredAt),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function createAgentContractService(context: AutonomyKernelContext) {
  const { db } = context;

  return {
    async getActiveContract(companyId: string, agentId: string, laneKey: string | null): Promise<AgentContractSummary | null> {
      const [row] = await db
        .select()
        .from(agentContracts)
        .where(
          and(
            eq(agentContracts.companyId, companyId),
            eq(agentContracts.agentId, agentId),
            eq(agentContracts.status, "active"),
            laneKey ? or(eq(agentContracts.laneKey, laneKey), isNull(agentContracts.laneKey)) : undefined,
          ),
        )
        .limit(1);
      return row ? toContractDto(row) : null;
    },

    async evaluateContract(request: PreflightRunRequest): Promise<ContractEvaluation> {
      if (!request.agentId) {
        return { status: "deny", reason: "Preflight requires an agent id", contract: null, requiresApprovalFor: [] };
      }

      const laneKey = request.laneKey ?? "default";
      const contract = await this.getActiveContract(request.companyId, request.agentId, laneKey);
      if (!contract) {
        if (!context.enforceAgentContracts) {
          return { status: "allow", reason: null, contract: null, requiresApprovalFor: [] };
        }
        return {
          status: "deny",
          reason: `No active autonomy contract for agent ${request.agentId} on lane ${laneKey}`,
          contract: null,
          requiresApprovalFor: [],
        };
      }

      const governedAction = request.governedAction ??
        (typeof request.metadata?.governedAction === "string" ? request.metadata.governedAction : null);
      if (governedAction && contract.requiresApprovalFor.includes(governedAction)) {
        return {
          status: "approval_required",
          reason: `Contract ${contract.name} requires approval for ${governedAction}`,
          contract,
          requiresApprovalFor: contract.requiresApprovalFor,
        };
      }

      return { status: "allow", reason: null, contract, requiresApprovalFor: contract.requiresApprovalFor };
    },
  };
}

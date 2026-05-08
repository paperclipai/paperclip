import { and, eq } from "drizzle-orm";
import { lanePolicies } from "@paperclipai/db";
import type { AutonomyLaneStatus, CompanyLaneStatus } from "@paperclipai/shared";
import type { AutonomyKernelContext, PreflightRunRequest } from "./types.js";

export interface LanePolicyEvaluation {
  status: "allow" | "blocked" | "deny";
  reason: string | null;
  policyId: string | null;
  laneKey: string;
  requiresApprovalFor: string[];
}

type LanePolicyRow = typeof lanePolicies.$inferSelect;

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function policyApprovalActions(row: LanePolicyRow): string[] {
  const policy = row.policy as Record<string, unknown> | null;
  return asStringArray(policy?.requiresApprovalFor);
}

function toLaneDto(row: LanePolicyRow): CompanyLaneStatus {
  return {
    companyId: row.companyId,
    laneKey: row.laneKey,
    laneName: row.laneName,
    status: row.status as AutonomyLaneStatus,
    statusReason: row.statusReason ?? null,
    activeRunId: row.activeRunId ?? null,
    activeIssueId: row.activeIssueId ?? null,
    activeAgentId: row.activeAgentId ?? null,
    queuedRunCount: 0,
    openIncidentCount: 0,
    criticalIncidentCount: 0,
    pendingApprovalCount: 0,
    lastTransition: null,
    stoppedByIncidentId: row.stoppedByIncidentId ?? null,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString(),
  };
}

export function createLanePolicyService(context: AutonomyKernelContext) {
  const { db } = context;

  async function getPolicy(companyId: string, laneKey: string): Promise<LanePolicyRow | null> {
    const [existing] = await db
      .select()
      .from(lanePolicies)
      .where(and(eq(lanePolicies.companyId, companyId), eq(lanePolicies.laneKey, laneKey)))
      .limit(1);
    if (existing) return existing;

    if (laneKey !== "default") return null;

    const now = new Date();
    const [created] = await db
      .insert(lanePolicies)
      .values({
        companyId,
        laneKey,
        laneName: "Default",
        isDefault: true,
        status: "healthy",
        maxConcurrentRuns: 1,
        maxManagerRuns: 0,
        allowParallelWithDependencyProof: false,
        allowRetry: false,
        maxRetryAttempts: 0,
        allowedAgentIds: [],
        allowedIssueTypes: [],
        allowedEvidenceTypes: [],
        policy: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [lanePolicies.companyId, lanePolicies.laneKey] })
      .returning();
    if (created) return created;

    const [concurrent] = await db
      .select()
      .from(lanePolicies)
      .where(and(eq(lanePolicies.companyId, companyId), eq(lanePolicies.laneKey, laneKey)))
      .limit(1);
    return concurrent ?? null;
  }

  return {
    async evaluateLane(request: PreflightRunRequest): Promise<LanePolicyEvaluation> {
      const laneKey = request.laneKey ?? "default";
      const policy = await getPolicy(request.companyId, laneKey);
      if (!policy) {
        return {
          status: "deny",
          reason: `Lane ${laneKey} is not provisioned`,
          policyId: null,
          laneKey,
          requiresApprovalFor: [],
        };
      }

      if (policy.status === "stopped" || policy.stoppedAt || policy.stoppedByIncidentId) {
        return {
          status: "blocked",
          reason: policy.statusReason ?? `Lane ${laneKey} is stopped`,
          policyId: policy.id,
          laneKey,
          requiresApprovalFor: policyApprovalActions(policy),
        };
      }

      if (policy.status === "blocked") {
        return {
          status: "blocked",
          reason: policy.statusReason ?? `Lane ${laneKey} is blocked`,
          policyId: policy.id,
          laneKey,
          requiresApprovalFor: policyApprovalActions(policy),
        };
      }

      if (request.agentId && policy.allowedAgentIds.length > 0 && !policy.allowedAgentIds.includes(request.agentId)) {
        return {
          status: "deny",
          reason: `Agent ${request.agentId} is not allowed on lane ${laneKey}`,
          policyId: policy.id,
          laneKey,
          requiresApprovalFor: policyApprovalActions(policy),
        };
      }

      if (policy.activeRunId && policy.activeRunId !== request.runId && policy.maxConcurrentRuns <= 1) {
        return {
          status: "blocked",
          reason: `Lane ${laneKey} already has active run ${policy.activeRunId}`,
          policyId: policy.id,
          laneKey,
          requiresApprovalFor: policyApprovalActions(policy),
        };
      }

      return {
        status: "allow",
        reason: null,
        policyId: policy.id,
        laneKey,
        requiresApprovalFor: policyApprovalActions(policy),
      };
    },

    async getCompanyLaneStatus(companyId: string): Promise<CompanyLaneStatus[]> {
      const rows = await db.select().from(lanePolicies).where(eq(lanePolicies.companyId, companyId));
      return rows.map(toLaneDto);
    },
  };
}

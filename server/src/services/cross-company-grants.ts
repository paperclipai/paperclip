import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { crossCompanyGrants } from "@paperclipai/db";
import type { AuthorizationAction, AuthorizationResource } from "./authorization.js";

export function crossCompanyGrantsEnabled(): boolean {
  const raw = process.env.PAPERCLIP_CROSS_COMPANY_GRANTS?.trim().toLowerCase();
  return raw === "enabled" || raw === "true" || raw === "1";
}

export function scopeMatches(
  scope: Record<string, unknown> | null | undefined,
  resource: AuthorizationResource,
): boolean {
  if (!scope || Object.keys(scope).length === 0) return true;

  for (const key of Object.keys(scope)) {
    if (key !== "projectId" && key !== "issueIds") {
      return false;
    }
  }

  if (typeof scope.projectId === "string") {
    if (resource.type === "project") {
      return resource.projectId === scope.projectId;
    }
    if (resource.type === "issue") {
      return resource.projectId === scope.projectId;
    }
    return false;
  }

  if (Array.isArray(scope.issueIds)) {
    const issueIds = scope.issueIds.filter((value): value is string => typeof value === "string");
    return resource.type === "issue" && Boolean(resource.issueId) && issueIds.includes(resource.issueId!);
  }

  return true;
}

export type CrossCompanyGrantEvaluation = {
  allowed: boolean;
  reason: "allow_cross_company_grant" | "deny_company_boundary" | "deny_scope" | "deny_budget_exceeded";
  explanation: string;
  grantId?: string;
};

export async function evaluateCrossCompanyGrant(
  db: Db,
  input: {
    granteeAgentId: string;
    targetCompanyId: string;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    now?: number;
  },
): Promise<CrossCompanyGrantEvaluation> {
  if (!crossCompanyGrantsEnabled()) {
    return {
      allowed: false,
      reason: "deny_company_boundary",
      explanation: "Agent key cannot access another company.",
    };
  }

  const service = crossCompanyGrantService(db);
  const grant = await service.findActiveCrossCompanyGrant({
    granteeAgentId: input.granteeAgentId,
    targetCompanyId: input.targetCompanyId,
    now: input.now,
  });

  if (!grant) {
    return {
      allowed: false,
      reason: "deny_company_boundary",
      explanation: "Agent key cannot access another company.",
    };
  }

  if (!service.actionAllowedByGrant(grant, input.action)) {
    return {
      allowed: false,
      reason: "deny_company_boundary",
      explanation: "Agent key cannot access another company.",
    };
  }

  if (!scopeMatches(grant.scope, input.resource)) {
    return {
      allowed: false,
      reason: "deny_scope",
      explanation: "Cross-company grant does not cover the requested scope.",
    };
  }

  if (grant.budgetCapCents != null && grant.budgetSpentCents >= grant.budgetCapCents) {
    return {
      allowed: false,
      reason: "deny_budget_exceeded",
      explanation: "Cross-company grant budget cap has been reached.",
    };
  }

  return {
    allowed: true,
    reason: "allow_cross_company_grant",
    explanation: `Cross-company grant ${grant.id} authorizes ${input.action} in ${input.targetCompanyId}.`,
    grantId: grant.id,
  };
}

export function crossCompanyGrantService(db: Db) {
  async function findActiveCrossCompanyGrant(input: {
    granteeAgentId: string;
    targetCompanyId: string;
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    const row = await db
      .select()
      .from(crossCompanyGrants)
      .where(
        and(
          eq(crossCompanyGrants.granteeAgentId, input.granteeAgentId),
          eq(crossCompanyGrants.targetCompanyId, input.targetCompanyId),
          eq(crossCompanyGrants.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!row) return null;
    if (row.expiresAt.getTime() <= now) {
      await markExpired(row.id);
      return null;
    }
    return row;
  }

  async function markExpired(grantId: string) {
    await db
      .update(crossCompanyGrants)
      .set({
        status: "expired",
        updatedAt: new Date(),
      })
      .where(eq(crossCompanyGrants.id, grantId));
  }

  async function incrementBudgetSpent(input: {
    granteeAgentId: string;
    targetCompanyId: string;
    costCents: number;
  }) {
    if (!crossCompanyGrantsEnabled() || input.costCents <= 0) return;
    const grant = await findActiveCrossCompanyGrant({
      granteeAgentId: input.granteeAgentId,
      targetCompanyId: input.targetCompanyId,
    });
    if (!grant) return;
    await db
      .update(crossCompanyGrants)
      .set({
        budgetSpentCents: sql`${crossCompanyGrants.budgetSpentCents} + ${input.costCents}`,
        updatedAt: new Date(),
      })
      .where(eq(crossCompanyGrants.id, grant.id));
  }

  function actionAllowedByGrant(
    grant: { actions: string[] },
    action: AuthorizationAction,
  ): boolean {
    return grant.actions.includes(action);
  }

  return {
    findActiveCrossCompanyGrant,
    markExpired,
    incrementBudgetSpent,
    actionAllowedByGrant,
  };
}

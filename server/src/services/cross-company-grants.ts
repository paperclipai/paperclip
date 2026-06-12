import { and, eq } from "drizzle-orm";
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

  let constrained = false;

  if (typeof scope.projectId === "string") {
    constrained = true;
    if (resource.type === "project" && resource.projectId !== scope.projectId) return false;
    if (resource.type === "issue" && resource.projectId !== scope.projectId) return false;
  }

  if (Array.isArray(scope.issueIds)) {
    constrained = true;
    const issueIds = scope.issueIds.filter((value): value is string => typeof value === "string");
    if (resource.type !== "issue" || !resource.issueId || !issueIds.includes(resource.issueId)) {
      return false;
    }
  }

  for (const key of Object.keys(scope)) {
    if (key !== "projectId" && key !== "issueIds") {
      return false;
    }
  }

  return !constrained ? true : constrained;
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
        budgetSpentCents: grant.budgetSpentCents + input.costCents,
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

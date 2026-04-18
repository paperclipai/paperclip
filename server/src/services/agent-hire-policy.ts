import { and, eq, gte, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentHireEvents,
  agentHirePolicies,
  type HireCombination,
} from "@paperclipai/db";
import type { UpdateHirePolicy } from "@paperclipai/shared";
import { tooManyRequests, unprocessable } from "../errors.js";

export interface HireRequestShape {
  adapterType: string;
  role: string;
  reportsTo: string | null | undefined;
}

export interface HirePolicyRow {
  id: string;
  agentId: string;
  companyId: string;
  allowedCombinations: HireCombination[];
  maxHiresPerMinute: number | null;
  maxHiresPerHour: number | null;
  notes: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function matchesCombination(
  request: HireRequestShape,
  callerAgentId: string,
  combination: HireCombination,
): boolean {
  if (combination.adapterType !== "*" && combination.adapterType !== request.adapterType) {
    return false;
  }
  if (combination.role !== "*" && combination.role !== request.role) {
    return false;
  }
  const parent = combination.parent;
  const requestedParent = request.reportsTo ?? null;
  if (parent === null) return true;
  if (parent === "*") return true;
  if (parent === "self") return requestedParent === callerAgentId;
  return requestedParent === parent;
}

export function agentHirePolicyService(db: Db) {
  async function getByAgentId(agentId: string): Promise<HirePolicyRow | null> {
    const rows = await db
      .select()
      .from(agentHirePolicies)
      .where(eq(agentHirePolicies.agentId, agentId))
      .limit(1);
    return (rows[0] ?? null) as HirePolicyRow | null;
  }

  async function upsert(
    companyId: string,
    agentId: string,
    input: UpdateHirePolicy,
    updatedByUserId: string | null,
  ): Promise<HirePolicyRow> {
    const now = new Date();
    const [row] = await db
      .insert(agentHirePolicies)
      .values({
        agentId,
        companyId,
        allowedCombinations: input.allowedCombinations,
        maxHiresPerMinute: input.maxHiresPerMinute ?? null,
        maxHiresPerHour: input.maxHiresPerHour ?? null,
        notes: input.notes ?? null,
        createdByUserId: updatedByUserId,
        updatedByUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentHirePolicies.agentId,
        set: {
          allowedCombinations: input.allowedCombinations,
          maxHiresPerMinute: input.maxHiresPerMinute ?? null,
          maxHiresPerHour: input.maxHiresPerHour ?? null,
          notes: input.notes ?? null,
          updatedByUserId,
          updatedAt: now,
        },
      })
      .returning();
    return row as HirePolicyRow;
  }

  async function enforce(
    callerAgentId: string,
    companyId: string,
    request: HireRequestShape,
  ): Promise<void> {
    const policy = await getByAgentId(callerAgentId);
    if (!policy) return;

    const combinations = policy.allowedCombinations ?? [];
    const allowed = combinations.some((c) =>
      matchesCombination(request, callerAgentId, c),
    );
    if (!allowed) {
      throw unprocessable("Hire policy: combination not allowed", {
        code: "hire_policy_denied",
        requested: {
          adapterType: request.adapterType,
          role: request.role,
          parent: request.reportsTo ?? null,
        },
        allowedCombinations: combinations,
      });
    }

    if (policy.maxHiresPerMinute == null && policy.maxHiresPerHour == null) {
      return;
    }

    await consumeRateLimitToken(callerAgentId, companyId, policy);
  }

  async function consumeRateLimitToken(
    callerAgentId: string,
    companyId: string,
    policy: HirePolicyRow,
  ): Promise<void> {
    const [inserted] = await db
      .insert(agentHireEvents)
      .values({ callerAgentId, companyId })
      .returning({ id: agentHireEvents.id, createdAt: agentHireEvents.createdAt });

    const now = inserted.createdAt.getTime();
    const hourAgo = new Date(now - 60 * 60 * 1000);

    const windowRows = await db
      .select({ createdAt: agentHireEvents.createdAt })
      .from(agentHireEvents)
      .where(
        and(
          eq(agentHireEvents.callerAgentId, callerAgentId),
          gte(agentHireEvents.createdAt, hourAgo),
        ),
      );

    const tooManyInMinute = (() => {
      if (policy.maxHiresPerMinute == null) return null;
      const minuteWindowStart = now - 60 * 1000;
      const inMinute = windowRows.filter((r) => r.createdAt.getTime() >= minuteWindowStart);
      if (inMinute.length <= policy.maxHiresPerMinute) return null;
      const oldest = inMinute.reduce(
        (acc, r) => (r.createdAt.getTime() < acc.getTime() ? r.createdAt : acc),
        inMinute[0].createdAt,
      );
      const retryAfter = Math.max(1, Math.ceil((60 * 1000 - (now - oldest.getTime())) / 1000));
      return {
        window: "minute" as const,
        limit: policy.maxHiresPerMinute,
        retryAfter,
      };
    })();

    const tooManyInHour = (() => {
      if (policy.maxHiresPerHour == null) return null;
      if (windowRows.length <= policy.maxHiresPerHour) return null;
      const oldest = windowRows.reduce(
        (acc, r) => (r.createdAt.getTime() < acc.getTime() ? r.createdAt : acc),
        windowRows[0].createdAt,
      );
      const retryAfter = Math.max(1, Math.ceil((60 * 60 * 1000 - (now - oldest.getTime())) / 1000));
      return {
        window: "hour" as const,
        limit: policy.maxHiresPerHour,
        retryAfter,
      };
    })();

    const violation = tooManyInMinute ?? tooManyInHour;
    if (violation) {
      await db.delete(agentHireEvents).where(eq(agentHireEvents.id, inserted.id));
      throw tooManyRequests(
        `Hire rate limit exceeded (per ${violation.window})`,
        violation.retryAfter,
        { code: "hire_rate_limit", window: violation.window, limit: violation.limit },
      );
    }

    // Opportunistic prune: remove events older than 1 hour for this caller.
    await db
      .delete(agentHireEvents)
      .where(
        and(
          eq(agentHireEvents.callerAgentId, callerAgentId),
          lt(agentHireEvents.createdAt, hourAgo),
        ),
      );
  }

  return {
    getByAgentId,
    upsert,
    enforce,
  };
}

export type AgentHirePolicyService = ReturnType<typeof agentHirePolicyService>;

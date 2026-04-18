import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
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
    const existing = await getByAgentId(agentId);
    const now = new Date();
    if (existing) {
      const [row] = await db
        .update(agentHirePolicies)
        .set({
          allowedCombinations: input.allowedCombinations,
          maxHiresPerMinute: input.maxHiresPerMinute ?? null,
          maxHiresPerHour: input.maxHiresPerHour ?? null,
          notes: input.notes ?? null,
          updatedByUserId,
          updatedAt: now,
        })
        .where(eq(agentHirePolicies.id, existing.id))
        .returning();
      return row as HirePolicyRow;
    }
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
      .returning();
    return row as HirePolicyRow;
  }

  async function enforce(
    callerAgentId: string,
    companyId: string,
    request: HireRequestShape,
  ): Promise<void> {
    const policy = await getByAgentId(callerAgentId);
    if (policy) {
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
      await checkRateLimit(callerAgentId, policy);
    }
  }

  async function checkRateLimit(
    callerAgentId: string,
    policy: HirePolicyRow,
  ): Promise<void> {
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000);
    const minuteAgo = new Date(now - 60 * 1000);

    if (policy.maxHiresPerMinute != null) {
      const rows = await db
        .select({ createdAt: agentHireEvents.createdAt })
        .from(agentHireEvents)
        .where(
          and(
            eq(agentHireEvents.callerAgentId, callerAgentId),
            gte(agentHireEvents.createdAt, minuteAgo),
          ),
        )
        .orderBy(desc(agentHireEvents.createdAt));
      if (rows.length >= policy.maxHiresPerMinute) {
        const oldest = rows[rows.length - 1].createdAt;
        const retryAfter =
          Math.max(1, Math.ceil((60 * 1000 - (now - oldest.getTime())) / 1000));
        throw tooManyRequests(
          "Hire rate limit exceeded (per minute)",
          retryAfter,
          { code: "hire_rate_limit", window: "minute", limit: policy.maxHiresPerMinute },
        );
      }
    }

    if (policy.maxHiresPerHour != null) {
      const rows = await db
        .select({ createdAt: agentHireEvents.createdAt })
        .from(agentHireEvents)
        .where(
          and(
            eq(agentHireEvents.callerAgentId, callerAgentId),
            gte(agentHireEvents.createdAt, hourAgo),
          ),
        )
        .orderBy(desc(agentHireEvents.createdAt));
      if (rows.length >= policy.maxHiresPerHour) {
        const oldest = rows[rows.length - 1].createdAt;
        const retryAfter =
          Math.max(1, Math.ceil((60 * 60 * 1000 - (now - oldest.getTime())) / 1000));
        throw tooManyRequests(
          "Hire rate limit exceeded (per hour)",
          retryAfter,
          { code: "hire_rate_limit", window: "hour", limit: policy.maxHiresPerHour },
        );
      }
    }
  }

  async function recordHireEvent(
    callerAgentId: string,
    companyId: string,
    createdAgentId: string,
  ): Promise<void> {
    await db.insert(agentHireEvents).values({
      callerAgentId,
      companyId,
      createdAgentId,
    });
    // Soft prune: remove events older than 1 hour for this caller to keep table small.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
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
    recordHireEvent,
  };
}

export type AgentHirePolicyService = ReturnType<typeof agentHirePolicyService>;

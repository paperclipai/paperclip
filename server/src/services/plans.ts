import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, planDetails } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { conflict, notFound, unprocessable } from "../errors.js";

// A MyHive "Plan" is an issue with workMode='planning' plus a 1:1 plan_details
// sidecar holding the plan lifecycle + tier (phase/wave) structure + budget caps.
// Activation materializes the first tier's requested children as real, workable
// issues stamped with planRootIssueId, so the rest of the engine treats them as
// ordinary tickets.

export interface PlanTier {
  id: string;
  kind: "phase" | "wave";
  name: string;
  requestedChildren: Record<string, unknown>[];
  childIssueIds: string[];
}

export interface CreatePlanInput {
  title: string;
  overview?: string | null;
  tiers?: PlanTier[];
  budgetCapCents?: number | null;
  budgetCapTokens?: number | null;
  assigneeAgentId?: string | null;
  createdByUserId?: string | null;
  createdByAgentId?: string | null;
}

function normalizeTiers(tiers: PlanTier[] | undefined): PlanTier[] {
  return (tiers ?? []).map((tier) => ({
    id: tier.id,
    kind: tier.kind,
    name: tier.name,
    requestedChildren: Array.isArray(tier.requestedChildren) ? tier.requestedChildren : [],
    childIssueIds: Array.isArray(tier.childIssueIds) ? tier.childIssueIds : [],
  }));
}

export function planService(db: Db) {
  const issues_ = issueService(db);

  return {
    createPlan: async (companyId: string, input: CreatePlanInput) => {
      const tiers = normalizeTiers(input.tiers);
      const issue = await issues_.create(companyId, {
        title: input.title,
        description: input.overview ?? null,
        workMode: "planning",
        status: "backlog",
        assigneeAgentId: input.assigneeAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
      });
      const [details] = await db
        .insert(planDetails)
        .values({
          issueId: issue.id,
          companyId,
          state: "draft",
          tiers: tiers as unknown as Record<string, unknown>[],
          budgetCapCents: input.budgetCapCents ?? null,
          budgetCapTokens: input.budgetCapTokens ?? null,
          createdByUserId: input.createdByUserId ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
        })
        .returning();
      return { issue, planDetails: details };
    },

    getPlan: async (issueId: string) => {
      const issue = await issues_.getById(issueId);
      if (!issue) return null;
      const [details] = await db.select().from(planDetails).where(eq(planDetails.issueId, issueId));
      if (!details) return null;
      // Tier progress: counts of child issues by status.
      const detailTiers = details.tiers as unknown as PlanTier[];
      const childIds = detailTiers.flatMap((tier) =>
        Array.isArray(tier.childIssueIds) ? tier.childIssueIds : [],
      );
      let childStatuses: { id: string; status: string }[] = [];
      if (childIds.length > 0) {
        childStatuses = await db
          .select({ id: issues.id, status: issues.status })
          .from(issues)
          .where(inArray(issues.id, childIds));
      }
      return { issue, planDetails: details, childStatuses };
    },

    updateTiers: async (issueId: string, tiers: PlanTier[]) => {
      const [details] = await db.select().from(planDetails).where(eq(planDetails.issueId, issueId));
      if (!details) throw notFound("Plan not found");
      if (details.state !== "draft") {
        throw conflict("Plan tiers can only be edited while the plan is in draft");
      }
      const [updated] = await db
        .update(planDetails)
        .set({ tiers: normalizeTiers(tiers) as unknown as Record<string, unknown>[], updatedAt: new Date() })
        .where(eq(planDetails.issueId, issueId))
        .returning();
      return updated;
    },

    // Materialize the first tier's requested children. Returns the created child
    // issues so the caller can queue assignment wakeups. Guards empty
    // decomposition (E9) BEFORE creating anything — no partial emit.
    activate: async (
      issueId: string,
      actor: { agentId: string | null; userId: string | null },
    ) => {
      const [details] = await db.select().from(planDetails).where(eq(planDetails.issueId, issueId));
      if (!details) throw notFound("Plan not found");
      if (details.state !== "draft") {
        throw conflict(`Plan cannot be activated from state '${details.state}'`);
      }
      const tiers = normalizeTiers(details.tiers as unknown as PlanTier[]);
      const firstTier = tiers[0];
      const requested = firstTier?.requestedChildren ?? [];
      if (requested.length === 0) {
        throw unprocessable("Plan has no first-tier tickets to activate");
      }

      const createdChildren = [];
      for (const child of requested) {
        const { issue } = await issues_.createChild(issueId, {
          title: String((child as Record<string, unknown>).title ?? "Untitled task"),
          description: ((child as Record<string, unknown>).description as string | null) ?? null,
          status: "todo",
          priority: ((child as Record<string, unknown>).priority as string | undefined) ?? "medium",
          assigneeAgentId: ((child as Record<string, unknown>).assigneeAgentId as string | null) ?? null,
          planRootIssueId: issueId,
          actorAgentId: actor.agentId,
          actorUserId: actor.userId,
        });
        createdChildren.push(issue);
      }

      firstTier.childIssueIds = createdChildren.map((c) => c.id);
      tiers[0] = firstTier;

      const [updated] = await db
        .update(planDetails)
        .set({ state: "active", activatedAt: new Date(), tiers: tiers as unknown as Record<string, unknown>[], updatedAt: new Date() })
        .where(eq(planDetails.issueId, issueId))
        .returning();

      return { planDetails: updated, createdChildren };
    },

    markStopped: async (issueId: string, reason: string) => {
      const [updated] = await db
        .update(planDetails)
        .set({ state: "stopped", stoppedAt: new Date(), stopReason: reason, updatedAt: new Date() })
        .where(eq(planDetails.issueId, issueId))
        .returning();
      return updated;
    },

    // All issue ids in a plan subtree (root + every descendant), ordered
    // deepest-first so leaves are deleted before their parents (issues.parentId
    // is a self-FK with no cascade).
    subtreeIssueIds: async (rootIssueId: string): Promise<string[]> => {
      const rows = await db.execute<{ id: string; depth: number }>(sql`
        WITH RECURSIVE tree AS (
          SELECT id, 0 AS depth FROM issues WHERE id = ${rootIssueId}
          UNION ALL
          SELECT c.id, t.depth + 1
          FROM issues c
          INNER JOIN tree t ON c.parent_id = t.id
        )
        SELECT id, depth FROM tree ORDER BY depth DESC
      `);
      const list = (rows as unknown as { rows?: { id: string }[] }).rows ?? (rows as unknown as { id: string }[]);
      return list.map((r) => r.id);
    },

    deletePlanSubtree: async (rootIssueId: string): Promise<string[]> => {
      const ids = await db.execute<{ id: string; depth: number }>(sql`
        WITH RECURSIVE tree AS (
          SELECT id, 0 AS depth FROM issues WHERE id = ${rootIssueId}
          UNION ALL
          SELECT c.id, t.depth + 1
          FROM issues c
          INNER JOIN tree t ON c.parent_id = t.id
        )
        SELECT id, depth FROM tree ORDER BY depth DESC
      `);
      const list = (ids as unknown as { rows?: { id: string }[] }).rows ?? (ids as unknown as { id: string }[]);
      const ordered = list.map((r) => r.id);
      // Break self-referential links across the subtree before deletion so FK
      // ordering can never block a row, then delete deepest-first.
      await db
        .update(issues)
        .set({ parentId: null, planRootIssueId: null })
        .where(inArray(issues.id, ordered));
      for (const id of ordered) {
        await issues_.remove(id);
      }
      return ordered;
    },

    setBudgetCaps: async (
      issueId: string,
      caps: { budgetCapCents?: number | null; budgetCapTokens?: number | null },
    ) => {
      const [updated] = await db
        .update(planDetails)
        .set({
          ...(caps.budgetCapCents !== undefined ? { budgetCapCents: caps.budgetCapCents } : {}),
          ...(caps.budgetCapTokens !== undefined ? { budgetCapTokens: caps.budgetCapTokens } : {}),
          updatedAt: new Date(),
        })
        .where(eq(planDetails.issueId, issueId))
        .returning();
      return updated;
    },
  };
}

export type PlanService = ReturnType<typeof planService>;
// Re-export for callers needing the live raw count expression.
export const planChildCountExpr = sql<number>`count(*)::int`;

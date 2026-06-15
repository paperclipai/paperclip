import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  budgetPolicies,
  costEvents,
  feedbackVotes,
  financeEvents,
  issueApprovals,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issues,
  planDetails,
} from "@paperclipai/db";
import type { PlanGateProfile } from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import {
  GATE_DESIGNATED_URL_KEY,
  buildGateApprovalsForActivation,
  isGateApprovalType,
  planApprovalAgentIds,
} from "./plan-gates.js";
import { resolveEffectiveGateProfile } from "./gate-triage.js";
import { logger } from "../middleware/logger.js";
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
  gateProfile?: PlanGateProfile | null;
  // Declared scope for the Layer 0 triage floor. When the touched paths hit a
  // high-risk surface (auth/payments/migration/secrets/public-api) or exceed the
  // file-count threshold, the persisted gateProfile is forced up to dev_team.
  touchedPaths?: string[] | null;
  fileCount?: number | null;
  assigneeAgentId?: string | null;
  projectId?: string | null;
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
  const agents_ = agentService(db);

  // Resolve the three gate-role agents by urlKey and create the gate approvals
  // for a dev_team plan activation. A missing/ambiguous agent yields a null
  // designatedAgentId (board fallback) and a warning — activation never fails
  // because a gate role is unstaffed. Returns the created approval ids.
  async function createActivationGates(
    companyId: string,
    planRootIssueId: string,
    leafIssueIds: string[],
    actor: { agentId: string | null; userId: string | null },
    gateProfile: PlanGateProfile | null,
  ): Promise<{ approvalIds: string[]; planApprovalAgentIds: string[] }> {
    const urlKeys = Array.from(new Set(Object.values(GATE_DESIGNATED_URL_KEY)));
    const designatedByUrlKey: Record<string, string | null> = {};
    for (const urlKey of urlKeys) {
      const { agent, ambiguous } = await agents_.resolveByReference(companyId, urlKey);
      designatedByUrlKey[urlKey] = agent?.id ?? null;
      if (!agent) {
        logger.warn(
          { companyId, planRootIssueId, urlKey, ambiguous },
          "dev_team gate role unresolved — gate falls back to board owner",
        );
      }
    }

    const specs = buildGateApprovalsForActivation({
      planRootIssueId,
      leafIssueIds,
      designatedByUrlKey,
      gateProfile,
    });

    const createdApprovalIds: string[] = [];
    for (const spec of specs) {
      const [approval] = await db
        .insert(approvals)
        .values({
          companyId,
          type: spec.type,
          status: "pending",
          requestedByAgentId: actor.agentId,
          requestedByUserId: actor.userId,
          payload: {
            gate: true,
            planRootIssueId,
            designatedAgentId: spec.designatedAgentId,
            ...(spec.lensKey != null ? { lensKey: spec.lensKey } : {}),
          },
          decisionNote: null,
          decidedByUserId: null,
          decidedByAgentId: null,
          decidedAt: null,
          updatedAt: new Date(),
        })
        .returning();
      await db.insert(issueApprovals).values({
        companyId,
        issueId: spec.issueId,
        approvalId: approval.id,
        linkedByAgentId: actor.agentId,
        linkedByUserId: actor.userId,
      });
      createdApprovalIds.push(approval.id);
    }
    return {
      approvalIds: createdApprovalIds,
      planApprovalAgentIds: planApprovalAgentIds(specs),
    };
  }

  // E6 run hygiene: sync issue-scoped, lifetime, hard-stop budget policies on
  // the plan-root issue from the plan's caps. Budget enforcement aggregates over
  // the issue subtree, so one root policy bounds total burn across every child
  // the dev_team plan spawns — the runaway guard for unattended runs.
  //
  // `deactivateCleared` controls the cleared-cap behavior: at activation we only
  // create policies for caps that are actually set; on a later cap edit we also
  // push amount 0 for a cleared cap so upsertPolicy deactivates the stale policy
  // (amount 0 -> isActive false) instead of leaving it enforcing an old limit.
  // Best-effort: a failure logs a warning but never blocks activation.
  async function syncIssueBudgetPolicies(
    companyId: string,
    planRootIssueId: string,
    caps: { budgetCapCents: number | null; budgetCapTokens: number | null },
    actor: { agentId: string | null; userId: string | null },
    opts: { deactivateCleared: boolean },
  ): Promise<void> {
    const budgets = budgetService(db);
    const cents = caps.budgetCapCents ?? 0;
    const tokens = caps.budgetCapTokens ?? 0;
    // When deactivating cleared caps, only touch metrics that already have a
    // policy — so clearing a token cap doesn't conjure a spurious inactive
    // billed_cents row for a metric that was never set.
    let existingMetrics = new Set<string>();
    if (opts.deactivateCleared) {
      const rows = await db
        .select({ metric: budgetPolicies.metric })
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "issue"),
            eq(budgetPolicies.scopeId, planRootIssueId),
          ),
        );
      existingMetrics = new Set(rows.map((r) => r.metric));
    }
    const policies: Array<{ metric: "billed_cents" | "total_tokens"; amount: number }> = [];
    if (cents > 0 || existingMetrics.has("billed_cents")) policies.push({ metric: "billed_cents", amount: cents });
    if (tokens > 0 || existingMetrics.has("total_tokens")) policies.push({ metric: "total_tokens", amount: tokens });
    for (const policy of policies) {
      try {
        await budgets.upsertPolicy(
          companyId,
          {
            scopeType: "issue",
            scopeId: planRootIssueId,
            metric: policy.metric,
            windowKind: "lifetime",
            amount: policy.amount,
            hardStopEnabled: true,
          },
          actor.userId,
        );
      } catch (error) {
        logger.warn(
          { companyId, planRootIssueId, metric: policy.metric, error: String(error) },
          "dev_team plan budget policy sync failed — runaway guard may be missing for this plan",
        );
      }
    }
  }

  return {
    createPlan: async (companyId: string, input: CreatePlanInput) => {
      const tiers = normalizeTiers(input.tiers);
      const issue = await issues_.create(companyId, {
        title: input.title,
        description: input.overview ?? null,
        workMode: "planning",
        status: "backlog",
        assigneeAgentId: input.assigneeAgentId ?? null,
        projectId: input.projectId ?? null,
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
          gateProfile: resolveEffectiveGateProfile(input.gateProfile, {
            touchedPaths: input.touchedPaths,
            fileCount: input.fileCount,
          }),
          createdByUserId: input.createdByUserId ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
        })
        .returning();
      return { issue, planDetails: details };
    },

    // List a company's plan roots (issues with a plan_details sidecar and no
    // parent) joined to their plan lifecycle. Optional state filter; newest
    // first. Returns [] when the company has no plans. Company scoping is the
    // caller's responsibility (route enforces 403 cross-company via authz).
    listPlans: async (
      companyId: string,
      opts: { state?: string | null } = {},
    ) => {
      const conditions = [eq(planDetails.companyId, companyId), isNull(issues.parentId)];
      if (opts.state) {
        conditions.push(eq(planDetails.state, opts.state));
      }
      return db
        .select({
          issueId: issues.id,
          title: issues.title,
          state: planDetails.state,
          gateProfile: planDetails.gateProfile,
          assigneeAgentId: issues.assigneeAgentId,
          createdAt: issues.createdAt,
        })
        .from(planDetails)
        .innerJoin(issues, eq(planDetails.issueId, issues.id))
        .where(and(...conditions))
        .orderBy(desc(issues.createdAt));
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

      // SOFT gate protocol: gates are advisory — they are materialized as
      // pending approvals so the board surfaces them, but nothing here blocks
      // activation or any downstream transition.
      let gateApprovalIds: string[] = [];
      // W5a: agents whose gate is actionable the moment the plan activates (the
      // architect's plan-approval gate). The caller wakes them directly so plan
      // review starts immediately instead of waiting for the global heartbeat.
      let planApprovalWakeAgentIds: string[] = [];
      // Any gated profile (solo/light/dev_team) arms the runaway budget policy —
      // solo/light still spawn an implementor that burns tokens. createActivationGates
      // emits the profile-sized gate set (0 for solo, 1/leaf for light, full for dev_team).
      if (details.gateProfile !== "none") {
        const gates = await createActivationGates(
          details.companyId,
          issueId,
          createdChildren.map((c) => c.id),
          actor,
          details.gateProfile as PlanGateProfile,
        );
        gateApprovalIds = gates.approvalIds;
        planApprovalWakeAgentIds = gates.planApprovalAgentIds;
        await syncIssueBudgetPolicies(
          details.companyId,
          issueId,
          { budgetCapCents: details.budgetCapCents, budgetCapTokens: details.budgetCapTokens },
          actor,
          { deactivateCleared: false },
        );
      }

      return { planDetails: updated, createdChildren, gateApprovalIds, planApprovalWakeAgentIds };
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
      // Purge gate_* approvals linked to any subtree issue. The issue_approvals
      // junction cascades on issue delete, but the approval rows themselves
      // would otherwise be orphaned (they carry no plan back-reference).
      if (ordered.length > 0) {
        const gateLinks = await db
          .select({ approvalId: issueApprovals.approvalId, type: approvals.type })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(inArray(issueApprovals.issueId, ordered));
        const gateApprovalIds = Array.from(
          new Set(gateLinks.filter((l) => isGateApprovalType(l.type)).map((l) => l.approvalId)),
        );
        if (gateApprovalIds.length > 0) {
          await db.delete(issueApprovals).where(inArray(issueApprovals.approvalId, gateApprovalIds));
          await db.delete(approvals).where(inArray(approvals.id, gateApprovalIds));
        }

        // Clear the RESTRICT (no onDelete) foreign keys that reference issues.id
        // and would otherwise block the issue delete with an FK violation (the
        // 500 on force-delete once an agent has run on the plan). Financial rows
        // are detached (SET NULL) to preserve the spend/finance trail that the
        // budget meters read; the issue-scoped ephemera are removed with the
        // issue. Add any future RESTRICT issue-referrer to this block.
        await db
          .update(costEvents)
          .set({ issueId: null })
          .where(inArray(costEvents.issueId, ordered));
        await db
          .update(financeEvents)
          .set({ issueId: null })
          .where(inArray(financeEvents.issueId, ordered));
        await db.delete(issueReadStates).where(inArray(issueReadStates.issueId, ordered));
        await db.delete(feedbackVotes).where(inArray(feedbackVotes.issueId, ordered));
        await db.delete(issueInboxArchives).where(inArray(issueInboxArchives.issueId, ordered));
        await db.delete(issueThreadInteractions).where(inArray(issueThreadInteractions.issueId, ordered));
        await db.delete(issueComments).where(inArray(issueComments.issueId, ordered));
      }
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
      // Re-sync the enforcement policy so a cap edited after activation actually
      // bites. upsertPolicy is keyed by scope+metric+window, so this updates the
      // existing E6 policy in place; deactivateCleared makes a removed cap
      // deactivate its stale policy instead of leaving it enforcing the old limit.
      if (updated?.gateProfile && updated.gateProfile !== "none") {
        await syncIssueBudgetPolicies(
          updated.companyId,
          issueId,
          { budgetCapCents: updated.budgetCapCents, budgetCapTokens: updated.budgetCapTokens },
          { agentId: null, userId: null },
          { deactivateCleared: true },
        );
      }
      return updated;
    },
  };
}

export type PlanService = ReturnType<typeof planService>;
// Re-export for callers needing the live raw count expression.
export const planChildCountExpr = sql<number>`count(*)::int`;

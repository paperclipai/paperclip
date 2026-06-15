import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { planService, type PlanTier } from "../services/plans.js";
import { agentService, heartbeatService, issueService, logActivity } from "../services/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { cancelIssueSubtree } from "../services/issue-subtree-cancel.js";
import { PLAN_APPROVAL_WAKE_REASON } from "../services/plan-gates.js";
import { publishLiveEvent } from "../services/live-events.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const planTierSchema = z.object({
  id: z.string(),
  kind: z.enum(["phase", "wave"]),
  name: z.string(),
  requestedChildren: z.array(z.record(z.unknown())).default([]),
  childIssueIds: z.array(z.string()).default([]),
});

const createPlanSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().min(1),
  overview: z.string().nullish(),
  tiers: z.array(planTierSchema).optional(),
  budgetCapCents: z.number().int().nonnegative().nullish(),
  budgetCapTokens: z.number().int().nonnegative().nullish(),
  gateProfile: z.enum(["none", "solo", "light", "dev_team"]).optional(),
  // Declared scope for the Layer 0 triage floor (gate-triage.ts). Optional —
  // when present, a high-risk path or large file count forces gateProfile up.
  touchedPaths: z.array(z.string()).optional(),
  fileCount: z.number().int().nonnegative().optional(),
  assigneeAgentId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
});

const listPlansQuerySchema = z.object({
  state: z.string().min(1).optional(),
});

const updateTiersSchema = z.object({
  tiers: z.array(planTierSchema),
});

const setBudgetCapsSchema = z
  .object({
    budgetCapCents: z.number().int().nonnegative().nullish(),
    budgetCapTokens: z.number().int().nonnegative().nullish(),
  })
  .refine((v) => v.budgetCapCents !== undefined || v.budgetCapTokens !== undefined, {
    message: "Provide budgetCapCents and/or budgetCapTokens",
  });

export function planRoutes(
  db: Db,
  opts: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const plans = planService(db);
  const issues = issueService(db);
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: opts.pluginWorkerManager });

  // Create a plan (manual authoring, or assign-to-agent so a CTO agent drafts it).
  router.post("/plans", async (req, res) => {
    const parsed = createPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid plan payload", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    assertCompanyAccess(req, body.companyId);
    const actor = getActorInfo(req);

    const { issue, planDetails } = await plans.createPlan(body.companyId, {
      title: body.title,
      overview: body.overview ?? null,
      tiers: body.tiers as PlanTier[] | undefined,
      budgetCapCents: body.budgetCapCents ?? null,
      budgetCapTokens: body.budgetCapTokens ?? null,
      gateProfile: body.gateProfile ?? "none",
      touchedPaths: body.touchedPaths ?? null,
      fileCount: body.fileCount ?? null,
      assigneeAgentId: body.assigneeAgentId ?? null,
      projectId: body.projectId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByAgentId: actor.agentId,
    });

    await logActivity(db, {
      companyId: body.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "plan.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        assigneeAgentId: body.assigneeAgentId ?? null,
        // Effective profile (the Layer 0 floor may have raised the request).
        gateProfile: planDetails.gateProfile,
        requestedGateProfile: body.gateProfile ?? "none",
      },
    });

    res.status(201).json({ issue, planDetails });
  });

  // List the plan roots for a company (board/agent dashboard). Joins root
  // issues with their plan_details sidecar; optional ?state= filter; newest
  // first. 403 when the actor cannot access the company; 200 [] when none.
  router.get("/companies/:companyId/plans", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listPlansQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      return;
    }
    const rows = await plans.listPlans(companyId, { state: parsed.data.state ?? null });
    res.json(rows);
  });

  router.get("/plans/:issueId", async (req, res) => {
    const result = await plans.getPlan(req.params.issueId as string);
    if (!result) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, result.issue.companyId);
    res.json(result);
  });

  router.put("/plans/:issueId/tiers", async (req, res) => {
    const parsed = updateTiersSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid tiers payload", details: parsed.error.flatten() });
      return;
    }
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const updated = await plans.updateTiers(req.params.issueId as string, parsed.data.tiers as PlanTier[]);
    res.json({ planDetails: updated });
  });

  // Set/clear the plan budget caps. For a dev_team plan this also re-syncs the
  // active hard-stop enforcement policy (see planService.setBudgetCaps), so a
  // cap edited after activation takes effect on the running plan.
  router.patch("/plans/:issueId/budget", async (req, res) => {
    const parsed = setBudgetCapsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid budget payload", details: parsed.error.flatten() });
      return;
    }
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const updated = await plans.setBudgetCaps(req.params.issueId as string, parsed.data);
    res.json({ planDetails: updated });
  });

  // Activate: materialize tier-1 tickets into the Open column (E9 guards empty).
  router.post("/plans/:issueId/activate", async (req, res) => {
    const planIssueId = req.params.issueId as string;
    const existing = await issues.getById(planIssueId);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const { planDetails, createdChildren, gateApprovalIds, planApprovalWakeAgentIds } = await plans.activate(planIssueId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "plan.activated",
      entityType: "issue",
      entityId: planIssueId,
      details: {
        childIssueIds: createdChildren.map((c) => c.id),
        gateApprovalIds,
      },
    });

    for (const child of createdChildren) {
      void queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: child.id, assigneeAgentId: child.assigneeAgentId, status: child.status },
        reason: "issue_assigned",
        mutation: "plan_activated",
        contextSource: "plan.activated",
        requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
        requestedByActorId: actor.actorId,
      });
    }

    // B3: if tier-1 children materialized without assignees (operator-authored plan),
    // wake the plan's own CTO so it can immediately assign them. Without this wake,
    // the unassigned children sit idle until the global heartbeat cadence (~1h).
    const unassignedChildIds = createdChildren
      .filter((c) => c.assigneeAgentId == null)
      .map((c) => c.id);
    const planAssigneeAgentId = existing.assigneeAgentId;
    if (unassignedChildIds.length > 0 && planAssigneeAgentId) {
      void (async () => {
        const agentList = await agentsSvc.list(existing.companyId);
        const assignableAgents = agentList
          .filter((a) => a.reportsTo === planAssigneeAgentId && a.status !== "terminated")
          .map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status }));
        void heartbeat
          .wakeup(planAssigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "plan_needs_assignment",
            payload: {
              issueId: planIssueId,
              mutation: "plan_activated",
              unassignedChildIds,
              assignableAgents,
            },
            requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
            requestedByActorId: actor.actorId,
            contextSnapshot: { issueId: planIssueId, source: "plan.activated.needs_assignment" },
          })
          .catch((err) => logger.warn({ err, planIssueId }, "failed to wake CTO for plan assignment"));
      })();
    }

    // W5a: wake the plan-approval gate agent(s) (the architect) directly so plan
    // review starts immediately rather than waiting for the global heartbeat
    // cadence. Only the plan-approval gate is actionable at activation; code/wiring
    // reviewers are woken when their leaf reaches in_review (W5b, not yet wired).
    for (const agentId of planApprovalWakeAgentIds) {
      void heartbeat
        .wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: PLAN_APPROVAL_WAKE_REASON,
          payload: { issueId: planIssueId, mutation: "plan_activated" },
          requestedByActorType: actor.actorType === "agent" ? "agent" : "user",
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: planIssueId, source: "plan.activated.gate" },
        })
        .catch((err) => logger.warn({ err, planIssueId, agentId }, "failed to wake plan-approval gate agent"));
    }

    publishLiveEvent({
      companyId: existing.companyId,
      type: "plan.state.changed",
      payload: {
        planIssueId,
        state: planDetails.state,
        childIssueIds: createdChildren.map((c) => c.id),
      },
    });

    res.json({ planDetails, childIssueIds: createdChildren.map((c) => c.id), gateApprovalIds });
  });

  // Stop a plan: cancel the whole subtree (runs + wakeups + statuses) and mark
  // the plan stopped. Safe no-op when nothing is running.
  router.post("/plans/:issueId/stop", async (req, res) => {
    const planIssueId = req.params.issueId as string;
    const existing = await issues.getById(planIssueId);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const reason = (req.body?.reason as string | undefined) ?? "Plan stopped from the board";
    const cancelResult = await cancelIssueSubtree(
      db,
      { heartbeat },
      { id: planIssueId, companyId: existing.companyId },
      {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
      reason,
    );

    const planDetails = await plans.markStopped(planIssueId, reason);

    publishLiveEvent({
      companyId: existing.companyId,
      type: "plan.state.changed",
      payload: { planIssueId, state: "stopped", reason, ...cancelResult },
    });

    const nothingRunning = cancelResult.runsCancelled === 0 && cancelResult.statusesCancelled === 0;
    res.json({
      planDetails,
      ...cancelResult,
      message: nothingRunning ? "Plan stopped — nothing was running" : "Plan stopped",
    });
  });

  // Delete a plan and its entire subtree. Cancels active work first so no
  // orphaned run writes to a deleted issue, then deletes deepest-first.
  router.delete("/plans/:issueId", async (req, res) => {
    const planIssueId = req.params.issueId as string;
    const existing = await issues.getById(planIssueId);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    await cancelIssueSubtree(
      db,
      { heartbeat },
      { id: planIssueId, companyId: existing.companyId },
      {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
      "Plan deleted from the board",
    );

    const deletedIds = await plans.deletePlanSubtree(planIssueId);

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "plan.deleted",
      entityType: "issue",
      entityId: planIssueId,
      details: { deletedIssueIds: deletedIds, deletedCount: deletedIds.length },
    });

    publishLiveEvent({
      companyId: existing.companyId,
      type: "plan.state.changed",
      payload: { planIssueId, state: "deleted", deletedIssueIds: deletedIds },
    });

    res.json({ deleted: true, deletedIssueIds: deletedIds });
  });

  return router;
}

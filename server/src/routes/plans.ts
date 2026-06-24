import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues as issuesTable, planDetails as planDetailsTable } from "@paperclipai/db";
import { planService, type PlanTier } from "../services/plans.js";
import { agentService, heartbeatService, issueRecoveryActionService, issueService, logActivity } from "../services/index.js";
import { diagnosePlanHealth } from "../services/plan-supervision.js";
import {
  addSupervisionNote,
  listSupervisionNotes,
  monitorNow,
} from "../services/plan-supervision-notes.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { cancelIssueSubtree } from "../services/issue-subtree-cancel.js";
import { PLAN_APPROVAL_WAKE_REASON, buildGateWorkspaceContext } from "../services/plan-gates.js";
import { publishLiveEvent } from "../services/live-events.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import { createCompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// Heartbeat run statuses that can be cancelled. Mirrors
// CANCELLABLE_HEARTBEAT_RUN_STATUSES in heartbeat.ts (module-private there);
// used to reject CTO cancel actions against already-terminal runs.
// SYNC: inverse of TERMINAL_RUN_STATUSES in services/plan-supervision.ts — if a new
// status is added, update both constants.
const CANCELLABLE_RUN_STATUSES: readonly string[] = ["queued", "running", "scheduled_retry"];

// Per-actor rate limit for the destructive supervision actions endpoint
// (cancel / reassign / stop_escalate). Lower than the search limit since these
// mutate live runs and plans. Sliding 1-minute window, 20 actions/actor.
const supervisionActionRateLimiter = createCompanySearchRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
});

const planTierSchema = z.object({
  id: z.string(),
  kind: z.enum(["phase", "wave"]),
  name: z.string(),
  requestedChildren: z.array(z.record(z.unknown())).default([]),
  childIssueIds: z.array(z.string()).default([]),
});

const createPlanSchema = z
  .object({
    companyId: z.string().uuid(),
    title: z.string().min(1),
    overview: z.string().nullish(),
    tiers: z.array(planTierSchema).optional(),
    budgetCapCents: z.number().int().nonnegative().nullish(),
    budgetCapTokens: z.number().int().nonnegative().nullish(),
    gateProfile: z.enum(["none", "solo", "light", "dev_team"]).optional(),
    // 'strict' requires a gated gateProfile (light or dev_team); 'soft' is the default.
    gateEnforcement: z.enum(["soft", "strict"]).optional(),
    // Declared scope for the Layer 0 triage floor (gate-triage.ts). Optional —
    // when present, a high-risk path or large file count forces gateProfile up.
    touchedPaths: z.array(z.string()).optional(),
    fileCount: z.number().int().nonnegative().optional(),
    assigneeAgentId: z.string().uuid().nullish(),
    projectId: z.string().uuid().nullish(),
  })
  .refine(
    (v) =>
      v.gateEnforcement !== "strict" ||
      (v.gateProfile !== undefined && v.gateProfile !== "none" && v.gateProfile !== "solo"),
    { message: "strict gateEnforcement requires a gated gateProfile (light or dev_team)" },
  );

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

const setGateProfileSchema = z.object({
  gateProfile: z.enum(["none", "solo", "light", "dev_team"]),
});

const setEstimateSchema = z
  .object({
    estimatedCompletionAt: z.string().datetime().nullish(),
    estimatorAgentId: z.string().uuid().nullish(),
  })
  .refine((v) => v.estimatedCompletionAt !== undefined || v.estimatorAgentId !== undefined, {
    message: "Provide estimatedCompletionAt and/or estimatorAgentId",
  });

export function planRoutes(
  db: Db,
  opts: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const plans = planService(db);
  const issues = issueService(db);
  const agentsSvc = agentService(db);
  const recoveryActions = issueRecoveryActionService(db);
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
      gateEnforcement: body.gateEnforcement ?? "soft",
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

  // Change the gate protocol for a plan. On active plans: upgrade (none/solo →
  // dev_team/light) creates missing pending approvals; downgrade (dev_team/light →
  // none/solo) cancels all pending gate approvals on the plan's issues.
  router.patch("/plans/:issueId/gate-profile", async (req, res) => {
    const parsed = setGateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid gate-profile payload", details: parsed.error.flatten() });
      return;
    }
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);
    const result = await plans.setGateProfile(req.params.issueId as string, parsed.data.gateProfile, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    res.json(result);
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
          contextSnapshot: {
            issueId: planIssueId,
            source: "plan.activated.gate",
            // Usually a no-op at activation (no worktree yet); included for
            // consistency so a plan reviewed against an existing worktree binds to it.
            ...buildGateWorkspaceContext(existing),
          },
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

  // Set or clear the CTO-managed ETA for a plan. Clears the overrun-notified
  // guard so resetting ETA re-enables the one-shot overrun wake.
  router.patch("/plans/:issueId/estimate", async (req, res) => {
    const parsed = setEstimateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid estimate payload", details: parsed.error.flatten() });
      return;
    }
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const rawEta = parsed.data.estimatedCompletionAt;
    const updated = await plans.setEstimate(req.params.issueId as string, {
      estimatedCompletionAt: rawEta != null ? new Date(rawEta) : rawEta,
      estimatorAgentId: parsed.data.estimatorAgentId,
    });
    // setEstimate updates 0 rows when the issue has no plan_details sidecar.
    // Don't report success (or fire the activity/live event) for a non-plan issue.
    if (!updated) {
      res.status(404).json({ error: "Issue is not a plan" });
      return;
    }
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "plan.estimate_set",
      entityType: "issue",
      entityId: existing.id,
      details: {
        estimatedCompletionAt: parsed.data.estimatedCompletionAt ?? null,
        estimatorAgentId: parsed.data.estimatorAgentId ?? null,
      },
    });
    publishLiveEvent({
      companyId: existing.companyId,
      type: "plan.updated",
      payload: { planIssueId: existing.id },
    });
    res.json({ planDetails: updated });
  });

  // Return the current health diagnosis for all agents assigned to active
  // subtree issues of a plan. Used by the CTO on an overrun wake.
  router.get("/plans/:issueId/supervision/health", async (req, res) => {
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const [planRow] = await db
      .select({ issueId: planDetailsTable.issueId })
      .from(planDetailsTable)
      .where(eq(planDetailsTable.issueId, existing.id));
    if (!planRow) {
      res.status(404).json({ error: "Issue is not a plan" });
      return;
    }
    const health = await diagnosePlanHealth(req.params.issueId as string, db);
    res.json({ health });
  });

  // healthSnapshot is intentionally NOT accepted from the request body — it is
  // a structured PlanHealthDiagnosis populated only by internal callers (the
  // overrun tick) via addSupervisionNote directly. Accepting arbitrary client
  // JSON here would let a caller store malformed data under that type.
  const addNoteSchema = z.object({
    kind: z.enum(["observation", "overrun", "action"]),
    severity: z.enum(["info", "warning", "critical"]).optional(),
    body: z.string().min(1).max(8000),
    targetAgentId: z.string().uuid().nullish(),
    targetIssueId: z.string().uuid().nullish(),
    actionTaken: z.string().nullish(),
  });

  // List supervision notes for a plan (most recent first, limit 50).
  router.get("/plans/:issueId/supervision-notes", async (req, res) => {
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const notes = await listSupervisionNotes(db, req.params.issueId as string, existing.companyId);
    res.json({ notes });
  });

  // Add a supervision note to a plan. Typically called by the CTO agent after
  // a monitoring wake; can also be called by a board actor for manual notes.
  router.post("/plans/:issueId/supervision-notes", async (req, res) => {
    const parsed = addNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid note payload", details: parsed.error.flatten() });
      return;
    }
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const note = await addSupervisionNote(db, {
      planIssueId: req.params.issueId as string,
      companyId: existing.companyId,
      authorAgentId: actor.agentId ?? null,
      authorUserId: actor.actorType === "user" ? actor.actorId : null,
      kind: parsed.data.kind,
      severity: parsed.data.severity,
      body: parsed.data.body,
      targetAgentId: parsed.data.targetAgentId ?? null,
      targetIssueId: parsed.data.targetIssueId ?? null,
      actionTaken: parsed.data.actionTaken ?? null,
    });

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "plan.supervision_note_added",
      entityType: "issue",
      entityId: existing.id,
      details: { kind: parsed.data.kind, severity: parsed.data.severity ?? "info", noteId: note.id },
    });

    publishLiveEvent({
      companyId: existing.companyId,
      type: "plan.supervision.note",
      payload: { planIssueId: existing.id, noteId: note.id },
    });

    res.status(201).json({ note });
  });

  // Trigger an on-demand CTO monitoring wake for this plan. Ignores the 15-min
  // interval gate — equivalent of clicking "Monitor now" in the drawer.
  router.post("/plans/:issueId/supervision/monitor", async (req, res) => {
    const existing = await issues.getById(req.params.issueId as string);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    try {
      const result = await monitorNow(db, heartbeat, req.params.issueId as string);
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        res.status(409).json({ error: (err as Error).message });
        return;
      }
      if (status === 404) {
        res.status(404).json({ error: (err as Error).message });
        return;
      }
      throw err;
    }
  });

  const supervisionActionSchema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("rewake"),
      targetAgentId: z.string().uuid(),
      body: z.string().min(1).max(2000).optional(),
    }),
    z.object({
      action: z.literal("cancel"),
      runId: z.string().uuid(),
      targetAgentId: z.string().uuid().optional(),
      reason: z.string().min(1).max(2000).optional(),
    }),
    z.object({
      action: z.literal("reassign"),
      targetIssueId: z.string().uuid(),
      newAssigneeAgentId: z.string().uuid(),
      body: z.string().min(1).max(2000).optional(),
    }),
    z.object({
      action: z.literal("stop_escalate"),
      reason: z.string().min(1).max(2000).optional(),
    }),
  ]);

  // CTO-callable remediation actions. Each dispatches to the appropriate
  // primitive and appends an action supervision note to the plan timeline.
  router.post("/plans/:issueId/supervision/actions", async (req, res) => {
    const parsed = supervisionActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid action payload", details: parsed.error.flatten() });
      return;
    }
    const planIssueId = req.params.issueId as string;
    const existing = await issues.getById(planIssueId);
    if (!existing) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const rateLimit = supervisionActionRateLimiter.consume({
      companyId: existing.companyId,
      actorType: actor.actorType === "agent" ? "agent" : "board",
      actorId: actor.agentId ?? actor.actorId ?? "unknown",
    });
    res.setHeader("X-RateLimit-Limit", String(rateLimit.limit));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    if (!rateLimit.allowed) {
      res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
      res.status(429).json({
        error: "Supervision action rate limit exceeded",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }

    const data = parsed.data;

    let actionTaken: string;
    let noteBody: string;
    let targetAgentId: string | null = null;
    let targetIssueId: string | null = null;

    if (data.action === "rewake") {
      const targetAgent = await agentsSvc.getById(data.targetAgentId);
      if (!targetAgent || targetAgent.companyId !== existing.companyId) {
        res.status(400).json({ error: "Target agent not found in this company" });
        return;
      }
      await heartbeat.wakeup(data.targetAgentId, {
        source: "on_demand",
        reason: "cto_rewake",
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
      actionTaken = "rewake";
      targetAgentId = data.targetAgentId;
      noteBody = data.body ?? `CTO re-woke agent ${data.targetAgentId.slice(0, 8)} to resume work.`;
    } else if (data.action === "cancel") {
      const [targetRun] = await db
        .select({ companyId: heartbeatRuns.companyId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, data.runId));
      if (!targetRun || targetRun.companyId !== existing.companyId) {
        res.status(400).json({ error: "Run not found in this company" });
        return;
      }
      // cancelRun is a no-op for runs already in a terminal status. Reject up
      // front so the CTO doesn't get a misleading success on an already-done run.
      if (!CANCELLABLE_RUN_STATUSES.includes(targetRun.status)) {
        res.status(409).json({ error: "Run is not in a cancellable state" });
        return;
      }
      await heartbeat.cancelRun(data.runId, data.reason ?? "Cancelled by CTO");
      actionTaken = "cancel";
      targetAgentId = data.targetAgentId ?? null;
      noteBody = data.reason ?? `CTO cancelled run ${data.runId.slice(0, 8)}.`;
    } else if (data.action === "reassign") {
      const targetIssue = await issues.getById(data.targetIssueId);
      if (!targetIssue || targetIssue.companyId !== existing.companyId) {
        res.status(400).json({ error: "Target issue not found in this company" });
        return;
      }
      const newAgent = await agentsSvc.getById(data.newAssigneeAgentId);
      if (!newAgent || newAgent.companyId !== existing.companyId) {
        res.status(400).json({ error: "New assignee agent not found in this company" });
        return;
      }
      // Mirror normalizeIssueAssigneeAgentReference (issues.ts): never assign
      // work to a dead/pending/invalid-org-chain agent, or the issue silently
      // stalls with an assignee that never picks it up.
      if (newAgent.status === "pending_approval") {
        res.status(409).json({ error: "Cannot assign work to pending approval agents" });
        return;
      }
      if (newAgent.status === "terminated") {
        res.status(409).json({ error: "Cannot assign work to terminated agents" });
        return;
      }
      if (newAgent.orgChainHealth?.status === "invalid_org_chain") {
        res.status(409).json({
          error: newAgent.orgChainHealth?.repairGuidance ?? "Cannot assign work to agents with invalid org chains",
        });
        return;
      }
      // Reject if an active recovery action targets this issue — reassigning
      // out from under it would leave the recovery action pointing at the old
      // agent. The board must resolve recovery first (see PATCH /issues/:id).
      const activeRecovery = await recoveryActions.getActiveForIssue(existing.companyId, data.targetIssueId);
      if (activeRecovery) {
        res.status(409).json({ error: "Issue has an active recovery action; resolve it before reassigning" });
        return;
      }
      const updatedIssue = await db
        .update(issuesTable)
        .set({ assigneeAgentId: data.newAssigneeAgentId, updatedAt: new Date() })
        .where(and(eq(issuesTable.id, data.targetIssueId), eq(issuesTable.companyId, existing.companyId)))
        .returning();
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: data.targetIssueId,
        details: { assigneeAgentId: data.newAssigneeAgentId, mutationSource: "cto_reassign" },
      });
      const reassignedIssue = updatedIssue[0];
      if (reassignedIssue) {
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: { id: reassignedIssue.id, assigneeAgentId: reassignedIssue.assigneeAgentId ?? null, status: reassignedIssue.status },
          reason: "issue_reassigned_by_cto",
          mutation: "assigneeAgentId",
          contextSource: "cto_supervision_action",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
        });
      }
      actionTaken = "reassign";
      targetIssueId = data.targetIssueId;
      targetAgentId = data.newAssigneeAgentId;
      noteBody = data.body ?? `CTO reassigned issue ${data.targetIssueId.slice(0, 8)} to agent ${data.newAssigneeAgentId.slice(0, 8)}.`;
    } else {
      // stop_escalate
      const reason = data.reason ?? "CTO stopped and escalated plan to board";
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
        reason,
      );
      await plans.markStopped(planIssueId, reason);
      publishLiveEvent({
        companyId: existing.companyId,
        type: "plan.state.changed",
        payload: { planIssueId, state: "stopped", reason },
      });
      actionTaken = "stop_escalate";
      noteBody = reason;
    }

    const note = await addSupervisionNote(db, {
      planIssueId,
      companyId: existing.companyId,
      authorAgentId: actor.agentId ?? null,
      authorUserId: actor.actorType === "user" ? actor.actorId : null,
      kind: "action",
      severity: "warning",
      body: noteBody,
      targetAgentId,
      targetIssueId,
      actionTaken,
    });

    publishLiveEvent({
      companyId: existing.companyId,
      type: "plan.supervision.note",
      payload: { planIssueId, noteId: note.id },
    });

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "plan.supervision_action_taken",
      entityType: "issue",
      entityId: planIssueId,
      details: { actionTaken, noteId: note.id },
    });

    res.status(201).json({ note, actionTaken });
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

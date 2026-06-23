import { Router, type Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues as issuesTable, planDetails as planDetailsTable } from "@paperclipai/db";
import {
  GATE_APPROVAL_TYPES,
  addApprovalCommentSchema,
  agentDecideApprovalSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  isGateApprovalType,
  criticGateWakeTarget,
  CRITIC_GATE_WAKE_REASON,
  REVIEW_GATE_WAKE_REASON,
  buildGateWorkspaceContext,
} from "../services/plan-gates.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  // Gate A (strict plan) — after a plan-approval gate is approved, wake the
  // first-tier assignees that were held by isWakeBlockedByStrictGate. Both the
  // board-approve and agent-decide handlers call this; it is a no-op for soft plans
  // and non-plan-approval types. Errors are logged and swallowed — the approval
  // itself is already committed.
  async function maybeWakeFirstTierOnStrictPlanApproval(
    approval: { type: string; companyId: string; payload: Record<string, unknown> },
    heartbeatSvc: ReturnType<typeof heartbeatService>,
  ) {
    if (approval.type !== GATE_APPROVAL_TYPES.planApproval) return;
    const planRootIssueId =
      typeof approval.payload.planRootIssueId === "string"
        ? approval.payload.planRootIssueId
        : null;
    if (!planRootIssueId) return;

    try {
      const [plan] = await db
        .select({ gateEnforcement: planDetailsTable.gateEnforcement, tiers: planDetailsTable.tiers })
        .from(planDetailsTable)
        .where(eq(planDetailsTable.issueId, planRootIssueId));

      if (!plan || plan.gateEnforcement !== "strict") return;

      const tiers = Array.isArray(plan.tiers) ? (plan.tiers as { childIssueIds?: unknown[] }[]) : [];
      const firstTier = tiers[0];
      const firstTierChildIds = (Array.isArray(firstTier?.childIssueIds) ? firstTier.childIssueIds : [])
        .filter((id): id is string => typeof id === "string");

      if (firstTierChildIds.length === 0) return;

      const children = await db
        .select({ id: issuesTable.id, assigneeAgentId: issuesTable.assigneeAgentId, status: issuesTable.status })
        .from(issuesTable)
        .where(
          and(
            eq(issuesTable.companyId, approval.companyId),
            inArray(issuesTable.id, firstTierChildIds),
          ),
        );

      for (const child of children) {
        void queueIssueAssignmentWakeup({
          heartbeat: heartbeatSvc,
          issue: { id: child.id, assigneeAgentId: child.assigneeAgentId ?? null, status: child.status },
          reason: "strict_plan_approval_approved",
          mutation: "strict_plan_gate_unblocked",
          contextSource: "plan.strict_gate_approved",
          requestedByActorType: "system",
        });
      }
    } catch (err) {
      logger.warn(
        { err, planRootIssueId, companyId: approval.companyId },
        "maybeWakeFirstTierOnStrictPlanApproval failed — first-tier wakes skipped",
      );
    }
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const planRootIssueId = req.query.planRootIssueId as string | undefined;
    const result = await svc.list(companyId, status, planRootIssueId);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    // W5d: when an agent creates a plan-level code-review gate (planRootIssueId set,
    // no linked leaf issues), auto-wake the designated reviewer so the board doesn't
    // need to manually intervene.
    const planRootIssueId =
      typeof approval.payload?.planRootIssueId === "string" ? approval.payload.planRootIssueId : null;
    const designatedAgentId =
      typeof approval.payload?.designatedAgentId === "string" ? approval.payload.designatedAgentId : null;
    if (
      approval.type === GATE_APPROVAL_TYPES.codeReview &&
      planRootIssueId &&
      designatedAgentId &&
      uniqueIssueIds.length === 0
    ) {
      heartbeat
        .wakeup(designatedAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: REVIEW_GATE_WAKE_REASON,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            approvalId: approval.id,
            planRootIssueId,
            source: "plan.plan_review.gate",
          },
        })
        .catch((err) =>
          logger.warn({ err, approvalId: approval.id, designatedAgentId }, "failed to wake plan reviewer"),
        );
    }

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.approve(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      // Gate A: strict plan — wake held first-tier assignees now that plan-approval passed.
      await maybeWakeFirstTierOnStrictPlanApproval(approval, heartbeat);
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  // Agent-only gate decision. The ONLY path by which an agent (not a board
  // user) decides an approval. Hard boundary: actor must be an agent, the
  // approval must be a gate_* type, and the actor must be the designated agent
  // recorded on the gate payload. Board/user actors keep using approve/reject.
  router.post("/approvals/:id/agent-decide", validate(agentDecideApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "Gate decisions are for the designated agent only" });
      return;
    }
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!isGateApprovalType(approval.type)) {
      res.status(403).json({ error: "Only dev-team gate approvals can be decided by an agent" });
      return;
    }
    const designatedAgentId =
      typeof approval.payload?.designatedAgentId === "string"
        ? approval.payload.designatedAgentId
        : null;
    if (designatedAgentId !== req.actor.agentId) {
      res.status(403).json({ error: "Only the designated agent can decide this gate" });
      return;
    }

    const decision = req.body.decision === "rejected" ? "rejected" : "approved";
    const { approval: updated } = await svc.decideByAgent(
      id,
      req.actor.agentId,
      decision,
      req.body.decisionNote,
    );

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "agent",
      actorId: req.actor.agentId,
      agentId: req.actor.agentId,
      action: decision === "approved" ? "approval.approved" : "approval.rejected",
      entityType: "approval",
      entityId: updated.id,
      details: {
        type: updated.type,
        gate: true,
        decidedByAgentId: req.actor.agentId,
      },
    });

    // W5d: when a plan-level code-review gate is decided (planRootIssueId in payload,
    // no linked leaf issues), wake the requesting agent (CTO) to continue assignment.
    const planGateRootId =
      typeof updated.payload?.planRootIssueId === "string" ? updated.payload.planRootIssueId : null;
    if (updated.type === GATE_APPROVAL_TYPES.codeReview && planGateRootId && updated.requestedByAgentId) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(updated.id);
      if (linkedIssues.length === 0) {
        heartbeat
          .wakeup(updated.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "plan_review_gate_decided",
            payload: { approvalId: updated.id, decision, planRootIssueId: planGateRootId },
            requestedByActorType: "agent",
            requestedByActorId: req.actor.agentId,
            contextSnapshot: {
              issueId: planGateRootId,
              approvalId: updated.id,
              decision,
            },
          })
          .catch((err) =>
            logger.warn({ err, approvalId: updated.id }, "failed to wake CTO after plan review gate"),
          );
      }
    }

    // B2 W5c: when a code-review or wiring-review gate approves, check if all
    // prerequisite gates on the same leaf are now approved. If so, wake the
    // completeness-critic with its pending approval's context.
    if (
      decision === "approved" &&
      (updated.type === GATE_APPROVAL_TYPES.codeReview ||
        updated.type === GATE_APPROVAL_TYPES.wiringReview)
    ) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(updated.id);
      for (const issue of linkedIssues) {
        const allApprovals = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
        const target = criticGateWakeTarget(allApprovals);
        if (!target) continue;
        heartbeat
          .wakeup(target.agentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: CRITIC_GATE_WAKE_REASON,
            payload: { issueId: issue.id, mutation: "review_gates_complete" },
            requestedByActorType: "agent",
            requestedByActorId: req.actor.agentId,
            contextSnapshot: {
              issueId: issue.id,
              source: "issue.review_gates_complete.critic",
              approvalId: target.approvalId,
              ...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
              // Bind the critic to the leaf's git worktree (see buildGateWorkspaceContext).
              ...buildGateWorkspaceContext(issue),
            },
          })
          .catch((err) =>
            logger.warn({ err, issueId: issue.id, agentId: target.agentId }, "failed to wake completeness-critic"),
          );
      }
    }
    // Gate A: strict plan — if architect just approved the plan-approval gate,
    // wake the first-tier implementors that were held by the strict gate.
    if (decision === "approved") {
      await maybeWakeFirstTierOnStrictPlanApproval(updated, heartbeat);
    }

    res.json(redactApprovalPayload(updated));
  });

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  // Agent-side withdrawal of a still-pending approval the agent itself created.
  // Without this, an agent that posts a mistaken/duplicate confirmation card has
  // no way off it (only the board can approve/reject) and burns turns hunting for
  // a non-existent cleanup path. Agent-only, ownership-checked, no side effects.
  router.post("/approvals/:id/cancel", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "Only the requesting agent can cancel an approval" });
      return;
    }
    if (req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only the requesting agent can cancel this approval" });
      return;
    }

    const reason = typeof req.body?.reason === "string" ? req.body.reason : null;
    const approval = await svc.cancel(id, req.actor.agentId, reason);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "agent",
      actorId: req.actor.agentId,
      agentId: req.actor.agentId,
      action: "approval.cancelled",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}

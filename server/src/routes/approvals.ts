import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
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
  issueService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
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
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  function approvalDecisionContext(approval: { payload: Record<string, unknown>; decisionNote?: string | null }) {
    const payload = typeof approval.payload === "object" && approval.payload !== null ? approval.payload : {};
    const readString = (value: unknown) => typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    return {
      title: readString(payload.title),
      summary: readString(payload.summary),
      recommendedAction: readString(payload.recommendedAction),
      planRevisionId:
        readString(payload.planRevisionId)
        ?? readString(payload.revisionId)
        ?? readString(payload.plan_revision_id)
        ?? readString((payload.plan as Record<string, unknown> | undefined)?.revisionId),
      decisionNote: readString(approval.decisionNote),
    };
  }

  function approvalResolutionComment(input: {
    approval: { id: string; status: string; type: string; payload: Record<string, unknown>; decisionNote?: string | null; requestedByAgentId?: string | null; requestedByUserId?: string | null };
    linkedIssueIds: string[];
    outcome: "approved" | "rejected" | "revision_requested";
  }) {
    const context = approvalDecisionContext(input.approval);
    const nextOwner =
      input.outcome === "revision_requested"
        ? `requester${input.approval.requestedByAgentId ? ` agent ${input.approval.requestedByAgentId}` : ""}${input.approval.requestedByUserId ? ` user ${input.approval.requestedByUserId}` : ""}`
        : "requesting agent or linked issue owner";
    const nextAction =
      input.outcome === "approved"
        ? "Resume the linked issue from the approved decision."
        : input.outcome === "rejected"
          ? "Record the rejected decision and choose a revised path or close the linked work."
          : "Revise and resubmit the approval, or close the linked work if the request is no longer needed.";
    const lines = [
      `Approval ${input.outcome}: ${input.approval.id}`,
      "",
      `- status: ${input.approval.status}`,
      `- type: ${input.approval.type}`,
      `- linkedIssueIds: ${input.linkedIssueIds.join(", ") || "none"}`,
      `- nextOwner: ${nextOwner}`,
      `- nextAction: ${nextAction}`,
    ];
    if (context.planRevisionId) lines.push(`- planRevisionId: ${context.planRevisionId}`);
    if (context.title) lines.push(`- title: ${context.title}`);
    if (context.summary) lines.push(`- summary: ${context.summary}`);
    if (context.recommendedAction) lines.push(`- recommendedAction: ${context.recommendedAction}`);
    if (context.decisionNote) lines.push(`- decisionNote: ${context.decisionNote}`);
    return lines.join("\n");
  }

  async function transitionLinkedIssuesToApprovalWait(input: {
    approvalId: string;
    linkedIssueIds: string[];
    actor: ReturnType<typeof getActorInfo>;
  }) {
    for (const issueId of input.linkedIssueIds) {
      const issue = await issuesSvc.getById(issueId);
      if (!issue || !["todo", "in_progress"].includes(issue.status)) continue;
      await issuesSvc.update(issueId, {
        status: "in_review",
        actorAgentId: input.actor.agentId ?? null,
        actorUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
      });
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        action: "issue.approval_wait_started",
        entityType: "issue",
        entityId: issueId,
        details: {
          approvalId: input.approvalId,
          previousStatus: issue.status,
          nextStatus: "in_review",
          reason: "linked approval owns the next action",
        },
      });
    }
  }

  async function recordLinkedApprovalDecision(input: {
    approval: { id: string; companyId: string; status: string; type: string; payload: Record<string, unknown>; decisionNote?: string | null; requestedByAgentId?: string | null; requestedByUserId?: string | null };
    outcome: "approved" | "rejected" | "revision_requested";
    actorUserId: string;
  }) {
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(input.approval.id);
    const linkedIssueIds = linkedIssues.map((issue) => issue.id);
    const body = approvalResolutionComment({
      approval: input.approval,
      linkedIssueIds,
      outcome: input.outcome,
    });

    for (const issue of linkedIssues) {
      const comment = await issuesSvc.addComment(issue.id, body, {}, {
        authorType: "system",
        metadata: {
          version: 1,
          sections: [
            {
              title: "Approval resolution",
              rows: [
                { type: "key_value", label: "approvalId", value: input.approval.id },
                { type: "key_value", label: "approvalStatus", value: input.approval.status },
                { type: "key_value", label: "outcome", value: input.outcome },
                { type: "key_value", label: "linkedIssueIds", value: linkedIssueIds.join(", ") || "none" },
              ],
            },
          ],
        },
      });
      await logActivity(db, {
        companyId: input.approval.companyId,
        actorType: "system",
        actorId: "approval_lifecycle",
        action: "issue.approval_resolution_recorded",
        entityType: "issue",
        entityId: issue.id,
        details: {
          approvalId: input.approval.id,
          approvalStatus: input.approval.status,
          outcome: input.outcome,
          linkedIssueIds,
          commentId: comment.id,
        },
      });
    }

    return { linkedIssues, linkedIssueIds };
  }

  async function wakeApprovalRequester(input: {
    approval: { id: string; companyId: string; status: string; requestedByAgentId?: string | null; payload: Record<string, unknown>; decisionNote?: string | null };
    linkedIssueIds: string[];
    reason: "approval_approved" | "approval_rejected" | "approval_revision_requested";
    actorUserId: string;
  }) {
    const primaryIssueId = input.linkedIssueIds[0] ?? null;
    if (!input.approval.requestedByAgentId) return null;
    const decisionContext = approvalDecisionContext(input.approval);
    return heartbeat.wakeup(input.approval.requestedByAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        approvalId: input.approval.id,
        approvalStatus: input.approval.status,
        issueId: primaryIssueId,
        issueIds: input.linkedIssueIds,
        linkedIssueIds: input.linkedIssueIds,
        decisionContext,
      },
      requestedByActorType: "user",
      requestedByActorId: input.actorUserId,
      contextSnapshot: {
        source: `approval.${input.approval.status}`,
        approvalId: input.approval.id,
        approvalStatus: input.approval.status,
        issueId: primaryIssueId,
        issueIds: input.linkedIssueIds,
        linkedIssueIds: input.linkedIssueIds,
        taskId: primaryIssueId,
        wakeReason: input.reason,
        decisionContext,
      },
    });
  }

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

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
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
      await transitionLinkedIssuesToApprovalWait({
        approvalId: approval.id,
        linkedIssueIds: uniqueIssueIds,
        actor,
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
      const { linkedIssueIds } = await recordLinkedApprovalDecision({
        approval,
        outcome: "approved",
        actorUserId: decidedByUserId,
      });

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
          const wakeRun = await wakeApprovalRequester({
            approval,
            linkedIssueIds,
            reason: "approval_approved",
            actorUserId: decidedByUserId,
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
      const { linkedIssueIds } = await recordLinkedApprovalDecision({
        approval,
        outcome: "rejected",
        actorUserId: decidedByUserId,
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedIssueIds },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await wakeApprovalRequester({
            approval,
            linkedIssueIds,
            reason: "approval_rejected",
            actorUserId: decidedByUserId,
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
              wakeReason: "approval_rejected",
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval rejection",
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
              wakeReason: "approval_rejected",
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
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
      const { linkedIssueIds } = await recordLinkedApprovalDecision({
        approval,
        outcome: "revision_requested",
        actorUserId: decidedByUserId,
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedIssueIds },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await wakeApprovalRequester({
            approval,
            linkedIssueIds,
            reason: "approval_revision_requested",
            actorUserId: decidedByUserId,
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
              wakeReason: "approval_revision_requested",
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval revision request",
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
              wakeReason: "approval_revision_requested",
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      res.json(redactApprovalPayload(approval));
    },
  );

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

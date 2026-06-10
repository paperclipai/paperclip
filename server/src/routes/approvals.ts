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
  heartbeatService,
  issueApprovalService,
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

  // TON-2324 / GH #7784: enqueue a wake for the agent that requested an approval
  // whenever the board replies — a decision (approve/reject/request-revision) or a
  // free-form comment. The reply text (`note`) is threaded into both the wake
  // payload and the context snapshot so the woken agent resumes with the board's
  // answer in hand instead of having to re-fetch the approval. Best-effort: a wake
  // failure is logged but never blocks the decision/comment response.
  async function wakeApprovalRequester(
    approval: {
      id: string;
      companyId: string;
      status: string;
      type: string;
      requestedByAgentId: string | null;
    },
    opts: {
      reason: string;
      source: string;
      note?: string | null;
      commentId?: string | null;
      requestedByActorType: "user" | "agent" | "system";
      requestedByActorId: string | null;
    },
  ) {
    if (!approval.requestedByAgentId) return;

    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const linkedIssueIds = linkedIssues.map((issue) => issue.id);
    const primaryIssueId = linkedIssueIds[0] ?? null;
    const note = opts.note?.trim() ? opts.note.trim() : null;

    try {
      const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: opts.reason,
        payload: {
          approvalId: approval.id,
          approvalStatus: approval.status,
          approvalType: approval.type,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          ...(note ? { note } : {}),
          ...(opts.commentId ? { commentId: opts.commentId } : {}),
        },
        requestedByActorType: opts.requestedByActorType,
        requestedByActorId: opts.requestedByActorId,
        contextSnapshot: {
          source: opts.source,
          approvalId: approval.id,
          approvalStatus: approval.status,
          approvalType: approval.type,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          taskId: primaryIssueId,
          wakeReason: opts.reason,
          ...(note ? { note } : {}),
          ...(opts.commentId ? { commentId: opts.commentId } : {}),
        },
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: opts.requestedByActorId ?? "board",
        action: "approval.requester_wakeup_queued",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          wakeRunId: wakeRun?.id ?? null,
          reason: opts.reason,
          commentId: opts.commentId ?? null,
          linkedIssueIds,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          approvalId: approval.id,
          requestedByAgentId: approval.requestedByAgentId,
          reason: opts.reason,
        },
        "failed to queue requester wakeup after approval reply",
      );
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: opts.requestedByActorId ?? "board",
        action: "approval.requester_wakeup_failed",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          reason: opts.reason,
          commentId: opts.commentId ?? null,
          linkedIssueIds,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
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

      await wakeApprovalRequester(approval, {
        reason: "approval_approved",
        source: "approval.approved",
        note: approval.decisionNote,
        requestedByActorType: "user",
        requestedByActorId: req.actor.userId ?? "board",
      });
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

      await wakeApprovalRequester(approval, {
        reason: "approval_rejected",
        source: "approval.rejected",
        note: approval.decisionNote,
        requestedByActorType: "user",
        requestedByActorId: req.actor.userId ?? "board",
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

      await wakeApprovalRequester(approval, {
        reason: "approval_revision_requested",
        source: "approval.revision_requested",
        note: approval.decisionNote,
        requestedByActorType: "user",
        requestedByActorId: req.actor.userId ?? "board",
      });

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

    // Wake the requesting agent on a board/peer reply — but never on the agent's
    // own comment (that would self-trigger an idle loop).
    if (approval.requestedByAgentId && actor.agentId !== approval.requestedByAgentId) {
      await wakeApprovalRequester(approval, {
        reason: "approval_commented",
        source: "approval.comment_added",
        note: req.body.body,
        commentId: comment.id,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    }

    res.status(201).json(comment);
  });

  return router;
}

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  agentService,
  approvalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
  getNotifications,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

type DelegationTransferPayload = {
  sourceIssueId: string;
  sourceIssueIdentifier: string | null;
  sourceCompanyId: string;
  targetCompanyId: string;
  targetAssigneeAgentId: string | null;
  targetAssigneeAgentName: string | null;
  targetStatus: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | null;
  note: string | null;
  requestedByUserId: string | null;
  requestedByAgentId: string | null;
  requestedByName: string | null;
};

function parseDelegationTransferPayload(payload: Record<string, unknown>): DelegationTransferPayload {
  const sourceIssueId =
    typeof payload.sourceIssueId === "string" && payload.sourceIssueId.trim().length > 0
      ? payload.sourceIssueId.trim()
      : "";
  const sourceCompanyId =
    typeof payload.sourceCompanyId === "string" && payload.sourceCompanyId.trim().length > 0
      ? payload.sourceCompanyId.trim()
      : "";
  const targetCompanyId =
    typeof payload.targetCompanyId === "string" && payload.targetCompanyId.trim().length > 0
      ? payload.targetCompanyId.trim()
      : "";

  if (!sourceIssueId || !sourceCompanyId || !targetCompanyId) {
    throw unprocessable(
      "delegate_issue_transfer payload must include sourceIssueId, sourceCompanyId, and targetCompanyId",
    );
  }

  const status =
    typeof payload.targetStatus === "string" && payload.targetStatus.trim().length > 0
      ? payload.targetStatus.trim()
      : null;
  const allowedStatuses = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
  const targetStatus =
    status && allowedStatuses.has(status) ? (status as DelegationTransferPayload["targetStatus"]) : null;

  return {
    sourceIssueId,
    sourceIssueIdentifier:
      typeof payload.sourceIssueIdentifier === "string" && payload.sourceIssueIdentifier.trim().length > 0
        ? payload.sourceIssueIdentifier.trim()
        : null,
    sourceCompanyId,
    targetCompanyId,
    targetAssigneeAgentId:
      typeof payload.targetAssigneeAgentId === "string" && payload.targetAssigneeAgentId.trim().length > 0
        ? payload.targetAssigneeAgentId.trim()
        : null,
    targetAssigneeAgentName:
      typeof payload.targetAssigneeAgentName === "string" && payload.targetAssigneeAgentName.trim().length > 0
        ? payload.targetAssigneeAgentName.trim()
        : null,
    targetStatus,
    note: typeof payload.note === "string" && payload.note.trim().length > 0 ? payload.note.trim() : null,
    requestedByUserId:
      typeof payload.requestedByUserId === "string" && payload.requestedByUserId.trim().length > 0
        ? payload.requestedByUserId.trim()
        : null,
    requestedByAgentId:
      typeof payload.requestedByAgentId === "string" && payload.requestedByAgentId.trim().length > 0
        ? payload.requestedByAgentId.trim()
        : null,
    requestedByName:
      typeof payload.requestedByName === "string" && payload.requestedByName.trim().length > 0
        ? payload.requestedByName.trim()
        : null,
  };
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const agentsSvc = agentService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

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

    void (async () => {
      const notif = getNotifications();
      if (!notif) return;
      let requestedByAgentName: string | null = null;
      if (approval.requestedByAgentId) {
        const requester = await agentsSvc.getById(approval.requestedByAgentId);
        requestedByAgentName = requester?.name ?? null;
      }
      const payload = approval.payload as Record<string, unknown>;
      const title =
        typeof payload.title === "string" && payload.title.trim()
          ? payload.title.trim()
          : typeof payload.name === "string" && payload.name.trim()
            ? payload.name.trim()
            : approval.type;
      await notif.notifyApprovalCreated(companyId, {
        approvalId: approval.id,
        type: approval.type,
        title,
        requestedByAgentName,
      });
    })().catch((err) => logger.warn({ err }, "Failed to send approval notification"));

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
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (existing.type === "delegate_issue_transfer") {
      const delegation = parseDelegationTransferPayload(existing.payload as Record<string, unknown>);
      assertCompanyAccess(req, delegation.targetCompanyId);
    }

    const approval = await svc.approve(id, req.body.decidedByUserId ?? "board", req.body.decisionNote);
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
    const linkedIssueIds = linkedIssues.map((issue) => issue.id);
    const primaryIssueId = linkedIssueIds[0] ?? null;

    if (approval.type === "delegate_issue_transfer") {
      const delegation = parseDelegationTransferPayload(approval.payload as Record<string, unknown>);
      const sourceIssueId = delegation.sourceIssueId || primaryIssueId;
      if (!sourceIssueId) {
        throw unprocessable("delegate_issue_transfer approval is missing source issue linkage");
      }

      const sourceIssue = await issuesSvc.getById(sourceIssueId);
      if (!sourceIssue) {
        throw unprocessable("Source issue not found for delegation transfer");
      }
      if (sourceIssue.companyId !== approval.companyId || sourceIssue.companyId !== delegation.sourceCompanyId) {
        throw unprocessable("Delegation source issue must belong to approval source company");
      }

      let targetAssigneeAgentId = delegation.targetAssigneeAgentId;
      let targetAssigneeAgentName = delegation.targetAssigneeAgentName;
      if (targetAssigneeAgentId) {
        const targetAssignee = await agentsSvc.getById(targetAssigneeAgentId);
        if (!targetAssignee || targetAssignee.companyId !== delegation.targetCompanyId) {
          targetAssigneeAgentId = null;
          targetAssigneeAgentName = null;
        } else {
          targetAssigneeAgentName = targetAssignee.name;
        }
      }

      const sourceRef = sourceIssue.identifier ?? sourceIssue.id.slice(0, 8);
      const metadataBlock = [
        "---",
        "Delegation transfer metadata:",
        `- Source issue: ${sourceRef} (${sourceIssue.id})`,
        `- Source company: ${sourceIssue.companyId}`,
        `- Approval ID: ${approval.id}`,
        `- Approved by: ${req.actor.userId ?? "board"}`,
        `- Approved at: ${new Date().toISOString()}`,
      ].join("\n");
      const targetDescription = sourceIssue.description
        ? `${sourceIssue.description}\n\n${metadataBlock}`
        : metadataBlock;

      const targetStatus =
        delegation.targetStatus ?? (targetAssigneeAgentId ? "todo" : "backlog");

      const createdTargetIssue = await issuesSvc.create(
        delegation.targetCompanyId,
        {
          title: `${sourceIssue.title} [from ${sourceRef} • ${approval.id.slice(0, 8)}]`,
          description: targetDescription,
          status: targetStatus,
          priority: sourceIssue.priority,
          assigneeAgentId: targetAssigneeAgentId,
          assigneeUserId: null,
          requestDepth: sourceIssue.requestDepth ?? 0,
          billingCode: sourceIssue.billingCode ?? null,
          createdByUserId: req.actor.userId ?? "board",
          createdByAgentId: null,
        },
        { skipAssignmentTemplateValidation: true, forceAssignment: true },
      );

      const sourceStatusAfterTransfer =
        sourceIssue.status === "done" || sourceIssue.status === "cancelled"
          ? sourceIssue.status
          : "in_review";
      await issuesSvc.update(
        sourceIssue.id,
        {
          assigneeAgentId: null,
          assigneeUserId: null,
          status: sourceStatusAfterTransfer,
        },
        { skipAssignmentTemplateValidation: true, forceAssignment: true },
      );

      const transferComment = [
        "Delegation transfer approved and executed.",
        "",
        `- Approval: ${approval.id}`,
        `- Target company: ${delegation.targetCompanyId}`,
        `- Target issue: ${createdTargetIssue.identifier ?? createdTargetIssue.id} (${createdTargetIssue.id})`,
        `- Target assignee: ${targetAssigneeAgentName ?? "unassigned"}`,
      ].join("\n");
      await issuesSvc.addComment(sourceIssue.id, transferComment, {
        userId: req.actor.userId ?? "board",
      });

      if (createdTargetIssue.assigneeAgentId) {
        void heartbeat
          .wakeup(createdTargetIssue.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "issue_assigned",
            payload: { issueId: createdTargetIssue.id, mutation: "delegation_transfer" },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: { issueId: createdTargetIssue.id, source: "approval.delegate_issue_transfer" },
          })
          .catch((err) => logger.warn({ err, issueId: createdTargetIssue.id }, "failed to wake delegated assignee"));
      }

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.delegate_issue_transfer.executed",
        entityType: "approval",
        entityId: approval.id,
        details: {
          sourceIssueId: sourceIssue.id,
          sourceIssueIdentifier: sourceIssue.identifier,
          targetCompanyId: delegation.targetCompanyId,
          targetIssueId: createdTargetIssue.id,
          targetIssueIdentifier: createdTargetIssue.identifier,
          targetAssigneeAgentId: createdTargetIssue.assigneeAgentId,
        },
      });
    }

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

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const approval = await svc.reject(id, req.body.decidedByUserId ?? "board", req.body.decisionNote);

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "approval.rejected",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const approval = await svc.requestRevision(
        id,
        req.body.decidedByUserId ?? "board",
        req.body.decisionNote,
      );

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

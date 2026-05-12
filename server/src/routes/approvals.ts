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

  async function listLinkedIssueRefs(
    approvalId: string,
    fallbackIssueIds: string[] = [],
    context: Record<string, unknown> = {},
  ) {
    try {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approvalId);
      const refs = linkedIssues.map((issue) => ({ id: issue.id, identifier: issue.identifier ?? null }));
      const seen = new Set(refs.map((issue) => issue.id));
      for (const issueId of fallbackIssueIds) {
        if (!seen.has(issueId)) refs.push({ id: issueId, identifier: null });
      }
      if (fallbackIssueIds.length > 0 && refs.length > linkedIssues.length) {
        logger.warn(
          { approvalId, issueIds: fallbackIssueIds, ...context },
          "approval activity linked issue refs partial after link",
        );
      }
      return refs;
    } catch (err) {
      logger.warn(
        { err, approvalId, issueIds: fallbackIssueIds, ...context },
        "failed to read approval linked issue refs for activity",
      );
      return fallbackIssueIds.map((id) => ({ id, identifier: null }));
    }
  }

  function linkedIssueActivityDetails(issueRefs: Array<{ id: string; identifier: string | null }>) {
    return {
      issueIds: issueRefs.map((issue) => issue.id),
      linkedIssueIds: issueRefs.map((issue) => issue.id),
      issueRefs,
    };
  }

  function notifyApprovalResolved(approval: { id: string; sourcePluginId: string | null; status: string; decisionNote: string | null; decidedByUserId: string | null; decidedAt: Date | null }) {
    if (!approval.sourcePluginId || !options.pluginWorkerManager) return;
    const worker = options.pluginWorkerManager.getWorker(approval.sourcePluginId);
    if (!worker) return;
    try {
      worker.notify("approvals.resolved", {
        approvalId: approval.id,
        status: approval.status,
        decisionNote: approval.decisionNote ?? null,
        decidedByUserId: approval.decidedByUserId ?? null,
        decidedAt: approval.decidedAt?.toISOString() ?? new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        { err, approvalId: approval.id, sourcePluginId: approval.sourcePluginId },
        "failed to notify plugin worker that approval resolved",
      );
    }
  }

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const sourcePluginId = req.query.sourcePluginId as string | undefined;
    const result = await svc.list(companyId, status, sourcePluginId);
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
	    let linkedIssueDetails = uniqueIssueIds.length > 0
	      ? linkedIssueActivityDetails(await listLinkedIssueRefs(approval.id, uniqueIssueIds, { action: "approval.created" }))
	      : { issueIds: [], linkedIssueIds: [], issueRefs: [] };
    if (uniqueIssueIds.length > 0 && linkedIssueDetails.issueIds.length === 0) {
      logger.warn({ approvalId: approval.id, issueIds: uniqueIssueIds }, "approval activity linked issue refs empty after link");
      linkedIssueDetails = linkedIssueActivityDetails(uniqueIssueIds.map((id) => ({ id, identifier: null })));
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, ...linkedIssueDetails },
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
      const linkedIssueRefs = await listLinkedIssueRefs(approval.id, [], { action: "approval.approved", phase: "after" });
      const linkedIssueDetails = linkedIssueActivityDetails(linkedIssueRefs);
      const linkedIssueIds = linkedIssueDetails.issueIds;
      const primaryIssueId = linkedIssueIds[0] ?? null;

      try {
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
            ...linkedIssueDetails,
          },
        });
      } catch (err) {
        logger.warn({ err, approvalId: approval.id }, "failed to log approval approval activity");
      }

      notifyApprovalResolved(approval);

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
      const linkedIssueRefs = await listLinkedIssueRefs(approval.id, [], { action: "approval.rejected", phase: "after" });
      const linkedIssueDetails = linkedIssueActivityDetails(linkedIssueRefs);

      try {
        await logActivity(db, {
          companyId: approval.companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "approval.rejected",
          entityType: "approval",
          entityId: approval.id,
          details: { type: approval.type, ...linkedIssueDetails },
        });
      } catch (err) {
        logger.warn({ err, approvalId: approval.id }, "failed to log approval rejection activity");
      }

      notifyApprovalResolved(approval);
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
	      const linkedIssueRefsBefore = await listLinkedIssueRefs(id, [], { action: "approval.revision_requested", phase: "before" });
	      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);
	      const linkedIssueDetails = linkedIssueActivityDetails(
	        linkedIssueRefsBefore.length > 0
	          ? linkedIssueRefsBefore
	          : await listLinkedIssueRefs(approval.id, [], { action: "approval.revision_requested", phase: "after" }),
	      );

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, ...linkedIssueDetails },
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
	    const linkedIssueRefsBefore = await listLinkedIssueRefs(id, [], { action: "approval.resubmitted", phase: "before" });
	    const approval = await svc.resubmit(id, normalizedPayload);
	    const linkedIssueDetails = linkedIssueActivityDetails(
	      linkedIssueRefsBefore.length > 0
	        ? linkedIssueRefsBefore
	        : await listLinkedIssueRefs(approval.id, [], { action: "approval.resubmitted", phase: "after" }),
	    );
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, ...linkedIssueDetails },
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

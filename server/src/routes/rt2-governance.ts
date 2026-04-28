import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { rt2GovernanceService } from "../services/rt2-governance.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import type {
  CreateApprovalRequest,
  Rt2Approval,
  Rt2ApprovalWithComments,
  Rt2GovernanceStatus,
  Rt2ActivityLogEntry,
} from "@paperclipai/shared";

const approvalTypeSchema = z.enum([
  "hire_agent",
  "approve_strategy",
  "task_completion",
  "deployment",
  "budget_exceed",
  "jarvis_auto_action",
  "jarvis_skill_capability",
]);

const createApprovalSchema = z.object({
  type: approvalTypeSchema,
  payload: z.record(z.unknown()),
  requestedByAgentId: z.string().uuid().optional(),
  requestedByUserId: z.string().optional(),
});

const decisionSchema = z.object({
  decisionNote: z.string().optional(),
});

const addCommentSchema = z.object({
  body: z.string().min(1),
  authorAgentId: z.string().uuid().optional(),
  authorUserId: z.string().optional(),
});

const activityLogQuerySchema = z.object({
  entityType: z.string().optional(),
  action: z.string().optional(),
  actorType: z.enum(["user", "agent", "system"]).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(1000).optional(),
});

const approvalQueueQuerySchema = z.object({
  type: approvalTypeSchema.optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

function assertBoardActor(req: { actor: { type: string; userId?: string } }): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw new Error("Board user required");
  }
  return req.actor.userId;
}

export function rt2GovernanceRoutes(db: Db) {
  const router = Router();
  const svc = rt2GovernanceService(db);

  // GET /companies/:companyId/rt2/governance/status
  router.get("/companies/:companyId/rt2/governance/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const status = await svc.getGovernanceStatus(companyId);
    res.json(status);
  });

  // GET /companies/:companyId/rt2/governance/approvals
  router.get("/companies/:companyId/rt2/governance/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = approvalQueueQuerySchema.safeParse(req.query);
    const filter = parsed.success ? parsed.data : undefined;
    const queue = await svc.getApprovalQueue(companyId, filter);
    res.json(queue);
  });

  // GET /companies/:companyId/rt2/governance/approvals/:id
  router.get("/companies/:companyId/rt2/governance/approvals/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const approvalId = req.params.id as string;
    const approval = await svc.getApprovalById(companyId, approvalId);

    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }

    res.json(approval);
  });

  // POST /companies/:companyId/rt2/governance/approvals
  router.post(
    "/companies/:companyId/rt2/governance/approvals",
    validate(createApprovalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as CreateApprovalRequest;
      const approval = await svc.createApproval(companyId, body);
      res.status(201).json(approval);
    },
  );

  // POST /companies/:companyId/rt2/governance/approvals/:id/approve
  router.post(
    "/companies/:companyId/rt2/governance/approvals/:id/approve",
    validate(decisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = assertBoardActor(req);

      const approvalId = req.params.id as string;
      const { decisionNote } = req.body as { decisionNote?: string };

      const approval = await svc.approve(companyId, approvalId, userId, decisionNote);
      res.json(approval);
    },
  );

  // POST /companies/:companyId/rt2/governance/approvals/:id/reject
  router.post(
    "/companies/:companyId/rt2/governance/approvals/:id/reject",
    validate(decisionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = assertBoardActor(req);

      const approvalId = req.params.id as string;
      const { decisionNote } = req.body as { decisionNote?: string };

      const approval = await svc.reject(companyId, approvalId, userId, decisionNote);
      res.json(approval);
    },
  );

  // POST /companies/:companyId/rt2/governance/approvals/:id/comments
  router.post(
    "/companies/:companyId/rt2/governance/approvals/:id/comments",
    validate(addCommentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const approvalId = req.params.id as string;
      const { body, authorAgentId, authorUserId } = req.body as {
        body: string;
        authorAgentId?: string;
        authorUserId?: string;
      };

      const comment = await svc.addComment(
        companyId,
        approvalId,
        { agentId: authorAgentId, userId: authorUserId },
        body,
      );
      res.status(201).json(comment);
    },
  );

  // GET /companies/:companyId/rt2/governance/activity-log
  router.get("/companies/:companyId/rt2/governance/activity-log", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = activityLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.errors });
      return;
    }

    const { fromDate, toDate, ...rest } = parsed.data;
    const filters = {
      ...rest,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    };

    const entries = await svc.getActivityLog(companyId, filters);
    res.json(entries);
  });

  return router;
}

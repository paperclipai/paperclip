import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  listResponsibilitiesQuerySchema,
  requestResponsibilityStatusUpdateSchema,
  writeResponsibilityStatusReportSchema,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService, heartbeatService, issueReferenceService, logActivity } from "../services/index.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { responsibilityService } from "../services/responsibilities.js";
import { responsibilityStatusReportService, type StatusReportAuthor } from "../services/responsibility-status-reports.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { boardCanManageResponsibilityOwner } from "./responsibilities.js";

const NOT_FOUND = "Responsibility not found";
const ownerQuerySchema = listResponsibilitiesQuerySchema.pick({ ownerUserId: true });

/**
 * Agent-written status for responsibilities (experimental
 * `enableResponsibilities`):
 * - reading it, for every active responsibility of an owner in one response
 *   (access rules repeat the overview route in `responsibilities.ts`) and for
 *   one responsibility;
 * - writing it: the reporting agent or an agent working under it, or a person
 *   who may edit the responsibility (the record says which; the body never
 *   names an author);
 * - the owner asking the reporter for an update, which opens a small task.
 */
export function responsibilityStatusReportRoutes(db: Db, opts: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const router = Router();
  const access = accessService(db);
  const svc = responsibilityStatusReportService(db);
  const responsibilitiesSvc = responsibilityService(db);
  const references = issueReferenceService(db);
  const heartbeat = opts.heartbeat ?? heartbeatService(db);

  async function assertCompanyRead(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    if (req.actor.type !== "agent") return;
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden("Responsibilities are outside this agent's authorization boundary", authorizationDeniedDetails(decision));
    }
  }

  async function loadForRead(req: Request, res: Response) {
    const row = await getAccessibleResource(req, res, responsibilitiesSvc.getById(req.params.id as string), NOT_FOUND);
    if (!row) return null;
    await assertCompanyRead(req, row.companyId);
    return row;
  }

  async function log(req: Request, input: { companyId: string; action: string; entityType: string; entityId: string; details?: Record<string, unknown> }) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details,
    });
  }

  router.get("/companies/:companyId/responsibilities/status-reports", async (req, res) => {
    await svc.assertEnabled();
    const companyId = req.params.companyId as string;
    await assertCompanyRead(req, companyId);
    const query = ownerQuerySchema.parse(req.query);
    const ownerUserId = query.ownerUserId ?? (req.actor.type === "board" ? req.actor.userId : undefined);
    if (!ownerUserId) {
      throw unprocessable(req.actor.type === "agent"
        ? "ownerUserId is required: name the person whose responsibilities to read"
        : "ownerUserId is required");
    }
    res.json(await svc.overview(companyId, ownerUserId));
  });

  router.get("/responsibilities/:id/status-report", async (req, res) => {
    await svc.assertEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    res.json(await svc.state(row));
  });

  router.post("/responsibilities/:id/status-report", validate(writeResponsibilityStatusReportSchema), async (req, res) => {
    await svc.assertEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    let author: StatusReportAuthor;
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      author = { type: "agent", agentId: req.actor.agentId };
      svc.assertCanBeWrittenBy(author, await svc.agentMayWrite(row, req.actor.agentId));
    } else {
      // A person (not assertBoard: agents call this route too, and the runner metadata reads that call as board-only).
      if (req.actor.type !== "board") throw forbidden("Board or agent access required");
      author = { type: "user", userId: req.actor.userId ?? "board" };
      svc.assertCanBeWrittenBy(author, boardCanManageResponsibilityOwner(req, row.companyId, row.ownerUserId));
    }
    const report = await svc.write(row, req.body, author);
    await log(req, {
      companyId: row.companyId,
      action: "responsibility.status_reported",
      entityType: "responsibility",
      entityId: row.id,
      details: { reportId: report.id, status: report.status, writtenBy: author.type, hasDetail: report.detail !== null },
    });
    res.status(201).json(await svc.state(row));
  });

  router.post(
    "/responsibilities/:id/status-report/request",
    validate(requestResponsibilityStatusUpdateSchema),
    async (req, res) => {
      await svc.assertEnabled();
      const row = await loadForRead(req, res);
      if (!row) return;
      assertBoard(req);
      if (!boardCanManageResponsibilityOwner(req, row.companyId, row.ownerUserId)) {
        throw forbidden("Only the person who owns this responsibility, or a company admin, can ask for an update");
      }
      const reporter = await svc.reporterOf(row);
      if (reporter) {
        // The same assignment permission the delegate route checks.
        const decision = await access.decide({
          actor: req.actor,
          action: "tasks:assign",
          resource: {
            type: "issue",
            companyId: row.companyId,
            issueId: null,
            projectId: null,
            parentIssueId: null,
            assigneeAgentId: reporter.agentId,
            assigneeUserId: null,
          },
        });
        if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
      }
      const actor = getActorInfo(req);
      const { issue, created } = await svc.requestUpdate(row, {
        userId: actor.actorId,
        runId: actor.runId,
        identityContextId: req.actor.identityContextId ?? null,
        authorizationActor: req.actor,
      });
      if (created && issue) {
        await references.syncIssue(issue.id);
        await log(req, {
          companyId: row.companyId,
          action: "issue.created",
          entityType: "issue",
          entityId: issue.id,
          details: { title: issue.title, identifier: issue.identifier, responsibilityId: row.id },
        });
        await log(req, {
          companyId: row.companyId,
          action: "responsibility.status_update_requested",
          entityType: "responsibility",
          entityId: row.id,
          details: { issueId: issue.id, identifier: issue.identifier, agentId: issue.assigneeAgentId },
        });
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "responsibility.status_update",
          requestedByActorType: "user",
          requestedByActorId: actor.actorId,
        });
      }
      const body = await svc.state(row);
      if (created) {
        res.status(201).json(body);
        return;
      }
      res.json(body);
    },
  );

  return router;
}

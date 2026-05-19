import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  paperclipSessionInspectRequestSchema,
  paperclipSessionReceiptRedactionRequestSchema,
  paperclipSessionResponseRequestSchema,
  paperclipSessionRollbackDisableRequestSchema,
  paperclipSessionTaskRouteRequestSchema,
  paperclipSessionTransitionRequestSchema,
  type PaperclipSessionActor,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity, sessionService } from "../services/index.js";
import { forbidden, unauthorized } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function sessionRoutes(db: Db) {
  const router = Router();
  const svc = sessionService(db);
  const access = accessService(db);

  function requestSessionActor(req: Request): PaperclipSessionActor {
    if (req.actor.type === "none") throw unauthorized();
    if (req.actor.type === "agent") {
      return {
        actorType: "agent",
        actorId: req.actor.agentId ?? "unknown-agent",
        agentId: req.actor.agentId ?? null,
        userId: null,
        runId: req.actor.runId ?? null,
      };
    }
    return {
      actorType: "board",
      actorId: req.actor.userId ?? "board",
      agentId: null,
      userId: req.actor.userId ?? "board",
      runId: req.actor.runId ?? null,
    };
  }

  function assertSameSessionActor(req: Request, actor: PaperclipSessionActor) {
    const expected = requestSessionActor(req);
    if (JSON.stringify(expected) !== JSON.stringify(actor)) {
      throw forbidden("Session actor must match authenticated request actor");
    }
  }

  async function assertSessionOperator(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Session operator board access required");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  function assertAgentResponseActor(req: Request, bodyActor: PaperclipSessionActor, participantAgentId: string) {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw unauthorized("Agent authentication required");
    }
    if (req.actor.agentId !== participantAgentId) {
      throw forbidden("Authenticated agent must match participant");
    }
    const authenticatedRunId = req.actor.runId?.trim();
    if (!authenticatedRunId) {
      throw unauthorized("Agent run id required");
    }
    if (bodyActor.actorType !== "agent" || bodyActor.agentId !== participantAgentId) {
      throw forbidden("Session response actor must match participant");
    }
    if (bodyActor.runId !== authenticatedRunId) {
      throw forbidden("Actor run id must match authenticated agent run");
    }
  }

  function filterInspectForActor(req: Request, result: any) {
    if (req.actor.type !== "agent" || !req.actor.agentId) return result;
    const participantIssueIds = new Set(
      (Array.isArray(result.participantIssues) ? result.participantIssues : [])
        .filter((issue: any) => issue?.assigneeAgentId === req.actor.agentId)
        .map((issue: any) => issue.id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
    );
    const filterReceipts = (receipts: unknown) => (
      Array.isArray(receipts)
        ? receipts.filter((receipt: any) =>
          receipt?.visibility === "participant_redacted" &&
          typeof receipt.issueId === "string" &&
          participantIssueIds.has(receipt.issueId))
        : []
    );
    const receipts = filterReceipts(result.receipts);
    const session = result.session && typeof result.session === "object"
      ? { ...result.session, receipts: filterReceipts(result.session.receipts) }
      : result.session;
    return { ...result, session, receipts };
  }

  router.post("/sessions/transition", validate(paperclipSessionTransitionRequestSchema), async (req, res) => {
    await assertSessionOperator(req, req.body.nextState.companyId);
    assertSameSessionActor(req, req.body.actor);
    const result = await svc.transition(req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "session.transition",
      entityType: "issue",
      entityId: req.body.issueId,
      details: {
        transition: req.body.transition,
        state: result.session.state,
        revisionId: result.document.latestRevisionId,
      },
    });
    res.status(result.replayed ? 200 : 202).json(result);
  });

  router.post("/sessions/respond", validate(paperclipSessionResponseRequestSchema), async (req, res) => {
    assertAgentResponseActor(req, req.body.actor, req.body.participantAgentId);
    const result = await svc.respond(req.body);
    res.status(201).json(result);
  });

  router.post("/sessions/inspect", validate(paperclipSessionInspectRequestSchema), async (req, res) => {
    const result = await svc.inspect(req.body);
    assertCompanyAccess(req, result.companyId);
    res.json(filterInspectForActor(req, result));
  });

  router.post("/sessions/task-route", validate(paperclipSessionTaskRouteRequestSchema), async (req, res) => {
    assertSameSessionActor(req, req.body.actor);
    const inspected = await svc.inspect({ issueId: req.body.issueId, includeReceipts: false });
    await assertSessionOperator(req, inspected.companyId);
    const result = await svc.routeTask(req.body);
    res.status(result.route.authorityPath === "failed_router" ? 202 : 201).json(result);
  });

  router.post("/sessions/receipt-redact", validate(paperclipSessionReceiptRedactionRequestSchema), async (req, res) => {
    assertSameSessionActor(req, req.body.actor);
    const inspected = await svc.inspect({ issueId: req.body.issueId, includeReceipts: false });
    await assertSessionOperator(req, inspected.companyId);
    const result = await svc.redactReceipt(req.body);
    res.status(201).json(result);
  });

  router.post("/sessions/rollback-disable", validate(paperclipSessionRollbackDisableRequestSchema), async (req, res) => {
    await assertSessionOperator(req, req.body.companyId);
    assertSameSessionActor(req, req.body.actor);
    const result = await svc.rollbackDisable(req.body);
    res.status(202).json(result);
  });

  return router;
}

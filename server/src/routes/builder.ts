import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  applyBuilderProposalSchema,
  createBuilderSessionSchema,
  rejectBuilderProposalSchema,
  sendBuilderMessageSchema,
  updateBuilderProviderSettingsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { builderService } from "../services/builder/index.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound } from "../errors.js";

/**
 * Company AI Builder REST routes.
 *
 * Phase 0 surface (read + chat, no mutations):
 *   GET    /api/companies/:companyId/builder/settings
 *   PUT    /api/companies/:companyId/builder/settings
 *   GET    /api/companies/:companyId/builder/tools
 *   GET    /api/companies/:companyId/builder/sessions
 *   POST   /api/companies/:companyId/builder/sessions
 *   GET    /api/companies/:companyId/builder/sessions/:sid
 *   POST   /api/companies/:companyId/builder/sessions/:sid/messages
 *   POST   /api/companies/:companyId/builder/sessions/:sid/abort
 *
 * Authz: board only in v0. Agents are blocked even with company access; the
 * Builder is an operator copilot, not an agent runtime surface. Phase 2 may
 * add a `builder:use` permission for agents.
 */
function assertBoardActor(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Builder is board-only in this release");
  }
}

function actorIdentity(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Builder is board-only in this release");
  }
  return {
    userId: req.actor.userId ?? "board",
  };
}

export function builderRoutes(db: Db) {
  const router = Router();
  const svc = builderService(db);

  // ------------------------------------------------------------------------
  // Provider settings
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const settings = await svc.getSettings(companyId);
    res.json({ settings });
  });

  router.put(
    "/companies/:companyId/builder/settings",
    validate(updateBuilderProviderSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const updated = await svc.upsertSettings(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.settings_updated",
        entityType: "builder_provider_settings",
        entityId: companyId,
        details: {
          providerType: updated.providerType,
          model: updated.model,
          hasApiKey: updated.hasApiKey,
        },
      });
      res.json({ settings: updated });
    },
  );

  // ------------------------------------------------------------------------
  // Tool catalog
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/tools", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(svc.getToolCatalog(companyId));
  });

  // ------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/sessions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const sessions = await svc.listSessions(companyId);
    res.json({ sessions });
  });

  router.post(
    "/companies/:companyId/builder/sessions",
    validate(createBuilderSessionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const session = await svc.createSession({
        companyId,
        createdByUserId: identity.userId,
        title: typeof req.body.title === "string" ? req.body.title : "",
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.created",
        entityType: "builder_session",
        entityId: session.id,
        details: { title: session.title, model: session.model },
      });
      res.status(201).json({ session });
    },
  );

  router.get("/companies/:companyId/builder/sessions/:sessionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const detail = await svc.getSessionDetail(companyId, req.params.sessionId as string);
    if (!detail) throw notFound("Session not found");
    res.json({ session: detail });
  });

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/messages",
    validate(sendBuilderMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const result = await svc.sendMessage({
        companyId,
        sessionId,
        actor: { type: "user", id: identity.userId },
        text: req.body.text,
      });
      if (!result) throw notFound("Session not found");
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.message_sent",
        entityType: "builder_session",
        entityId: sessionId,
        details: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          truncated: result.truncated,
          newMessageCount: result.newMessages.length,
        },
      });
      res.json({
        userMessage: result.userMessage,
        newMessages: result.newMessages,
        usage: result.usage,
        truncated: result.truncated,
      });
    },
  );

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/abort",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const aborted = await svc.abortSession(companyId, sessionId);
      if (!aborted) throw notFound("Session not found");
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.aborted",
        entityType: "builder_session",
        entityId: sessionId,
        details: null,
      });
      res.json({ session: aborted });
    },
  );

  // ------------------------------------------------------------------------
  // SSE streaming
  // ------------------------------------------------------------------------
  // POST .../messages/stream — same payload as /messages but writes the
  // result as a Server-Sent Events stream. Phase 4: provider streaming will
  // be added; for now we stream a single end-of-turn event so clients can
  // start using the API now and gain incremental updates later transparently.

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/messages/stream",
    validate(sendBuilderMessageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const ac = new AbortController();
      req.on("close", () => ac.abort());

      send("start", { sessionId });

      try {
        const result = await svc.sendMessage({
          companyId,
          sessionId,
          actor: { type: "user", id: identity.userId },
          text: req.body.text,
          signal: ac.signal,
        });
        if (!result) {
          send("error", { error: "Session not found" });
          res.end();
          return;
        }
        send("user_message", result.userMessage);
        for (const message of result.newMessages) {
          send("message", message);
        }
        send("done", {
          usage: result.usage,
          truncated: result.truncated,
          messageCount: result.newMessages.length,
        });
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "builder.session.message_sent",
          entityType: "builder_session",
          entityId: sessionId,
          details: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            truncated: result.truncated,
            newMessageCount: result.newMessages.length,
            stream: true,
          },
        });
      } catch (err) {
        send("error", {
          error: err instanceof Error ? err.message : "Builder run failed",
        });
      } finally {
        res.end();
      }
    },
  );

  // ------------------------------------------------------------------------
  // Proposals (Phases 1 + 2)
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const sessionId =
      typeof req.query.sessionId === "string" ? (req.query.sessionId as string) : undefined;
    const status =
      typeof req.query.status === "string"
        ? (req.query.status as Parameters<typeof svc.listProposals>[1] extends infer F
            ? F extends { status?: infer S }
              ? S
              : never
            : never)
        : undefined;
    const proposals = await svc.listProposals(companyId, { sessionId, status });
    res.json({ proposals });
  });

  router.get(
    "/companies/:companyId/builder/proposals/:proposalId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const proposalId = req.params.proposalId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const proposal = await svc.getProposal(companyId, proposalId);
      if (!proposal) throw notFound("Proposal not found");
      res.json({ proposal });
    },
  );

  router.post(
    "/companies/:companyId/builder/proposals/:proposalId/apply",
    validate(applyBuilderProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const proposalId = req.params.proposalId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const proposal = await svc.applyProposal(companyId, proposalId, identity.userId);
      res.json({ proposal });
    },
  );

  router.post(
    "/companies/:companyId/builder/proposals/:proposalId/reject",
    validate(rejectBuilderProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const proposalId = req.params.proposalId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const proposal = await svc.rejectProposal(companyId, proposalId, identity.userId);
      res.json({ proposal });
    },
  );

  return router;
}

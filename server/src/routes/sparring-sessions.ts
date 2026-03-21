import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  createSparringSessionSchema,
  recordSparringTurnSchema,
  completeSparringSessionSchema,
  abortSparringSessionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { sparringService } from "../services/sparring.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { logActivity } from "../services/activity-log.js";
import { notFound, conflict, forbidden, unprocessable } from "../errors.js";

export function sparringSessionRoutes(db: Db) {
  const router = Router();
  const sparring = sparringService(db);
  const issues = issueService(db);
  const docs = documentService(db);

  // POST /api/issues/:id/sparring-sessions — Create session
  router.post("/issues/:id/sparring-sessions", validate(createSparringSessionSchema), async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await issues.getById(issueId);
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);

    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || issue.checkoutRunId !== actor.runId) {
      throw forbidden("Only the checkout-owning agent can create a sparring session");
    }

    const existing = await sparring.getActiveSessionForIssue(issue.id);
    if (existing) throw conflict("An active sparring session already exists on this issue");

    const [participant] = await db.select().from(agents).where(eq(agents.id, req.body.participantAgentId));
    if (!participant || participant.companyId !== issue.companyId) {
      throw unprocessable("Participant agent not found or not in same company");
    }

    const result = await sparring.createSession({
      companyId: issue.companyId,
      issueId: issue.id,
      runId: actor.runId,
      coordinatorAgentId: actor.actorId,
      topic: req.body.topic,
      participantAgentId: req.body.participantAgentId,
      participantRole: req.body.participantRole,
      config: req.body.config,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "sparring_session.created",
      entityType: "sparring_session",
      entityId: result.session.id,
      details: { issueId: issue.id, topic: req.body.topic, participantAgentId: req.body.participantAgentId },
    });

    res.status(201).json(result.session);
  });

  // GET /api/sparring-sessions/:id — Get session details
  router.get("/sparring-sessions/:id", async (req, res) => {
    const session = await sparring.getSession(req.params.id as string);
    if (!session) throw notFound("Sparring session not found");
    assertCompanyAccess(req, session.companyId);
    res.json(session);
  });

  // POST /api/sparring-sessions/:id/turns — Record turn
  router.post("/sparring-sessions/:id/turns", validate(recordSparringTurnSchema), async (req, res) => {
    const session = await sparring.getSession(req.params.id as string);
    if (!session) throw notFound("Sparring session not found");
    assertCompanyAccess(req, session.companyId);

    if (session.status !== "active") {
      throw unprocessable("Session is not active");
    }

    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || actor.actorId !== session.coordinatorAgentId) {
      throw forbidden("Only the coordinator can record turns");
    }

    const config = (session.config as { maxRounds?: number } | null) ?? {};
    if (config.maxRounds && req.body.roundNumber > config.maxRounds) {
      throw unprocessable(`Round ${req.body.roundNumber} exceeds maxRounds (${config.maxRounds})`);
    }

    const turn = await sparring.recordTurn({
      sessionId: session.id,
      ...req.body,
    });

    await logActivity(db, {
      companyId: session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "sparring_session.turn_recorded",
      entityType: "sparring_session",
      entityId: session.id,
      details: { turnNumber: turn.turnNumber, roundNumber: turn.roundNumber, role: turn.role },
    });

    res.status(201).json(turn);
  });

  // GET /api/sparring-sessions/:id/turns — List turns
  router.get("/sparring-sessions/:id/turns", async (req, res) => {
    const session = await sparring.getSession(req.params.id as string);
    if (!session) throw notFound("Sparring session not found");
    assertCompanyAccess(req, session.companyId);

    const turns = await sparring.listTurns(session.id);
    res.json(turns);
  });

  // POST /api/sparring-sessions/:id/complete — Complete session
  router.post("/sparring-sessions/:id/complete", validate(completeSparringSessionSchema), async (req, res) => {
    const session = await sparring.getSession(req.params.id as string);
    if (!session) throw notFound("Sparring session not found");
    assertCompanyAccess(req, session.companyId);

    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || actor.actorId !== session.coordinatorAgentId) {
      throw forbidden("Only the coordinator can complete the session");
    }

    const updated = await sparring.completeSession(session.id, req.body.summary);
    if (!updated) throw conflict("Session is not active");

    // Build transcript document
    const turns = await sparring.listTurns(session.id);
    const transcriptLines = [`# Sparring: ${session.topic}\n`];
    for (const turn of turns) {
      transcriptLines.push(`## Round ${turn.roundNumber} — ${turn.role} (Turn ${turn.turnNumber})\n`);
      transcriptLines.push(turn.content);
      transcriptLines.push("");
    }
    transcriptLines.push(`## Summary\n`);
    transcriptLines.push(req.body.summary);

    // Save as issue document
    await docs.upsertIssueDocument({
      issueId: session.issueId,
      key: "sparring",
      title: `Sparring: ${session.topic}`,
      format: "markdown",
      body: transcriptLines.join("\n"),
      baseRevisionId: null,
      createdByAgentId: actor.agentId,
      createdByUserId: null,
    });

    // Post summary comment
    const totalTokens = turns.reduce((sum, t) => sum + (t.tokenCount ?? 0), 0);
    const commentBody = [
      `## Sparring Complete`,
      ``,
      `**Topic:** ${session.topic}`,
      `**Turns:** ${turns.length} | **Tokens:** ${totalTokens}`,
      ``,
      req.body.summary,
      ``,
      `[Full transcript →](#document-sparring)`,
    ].join("\n");

    await issues.addComment(session.issueId, commentBody, { agentId: actor.actorId });

    await logActivity(db, {
      companyId: session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "sparring_session.completed",
      entityType: "sparring_session",
      entityId: session.id,
      details: { turnCount: turns.length, totalTokens },
    });

    res.json(updated);
  });

  // POST /api/sparring-sessions/:id/abort — Abort session
  router.post("/sparring-sessions/:id/abort", validate(abortSparringSessionSchema), async (req, res) => {
    const session = await sparring.getSession(req.params.id as string);
    if (!session) throw notFound("Sparring session not found");
    assertCompanyAccess(req, session.companyId);

    const actor = getActorInfo(req);
    if (actor.actorType === "agent" && actor.actorId !== session.coordinatorAgentId) {
      throw forbidden("Only the coordinator or board can abort a session");
    }

    const updated = await sparring.abortSession(session.id, req.body?.reason);
    if (!updated) throw conflict("Session is not active");

    await logActivity(db, {
      companyId: session.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "sparring_session.aborted",
      entityType: "sparring_session",
      entityId: session.id,
      details: { reason: req.body?.reason },
    });

    res.json(updated);
  });

  return router;
}

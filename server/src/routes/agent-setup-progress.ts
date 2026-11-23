import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { toolConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import {
  agentSetupItemKeyPattern,
  createAgentSetupProgressSchema,
  finishAgentSetupSchema,
  setAgentSetupChecklistSchema,
  updateAgentSetupItemSchema,
  type CreateAgentSetupProgress,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { accessService } from "../services/index.js";
import { connectionRequestUserId } from "./connection-management-authz.js";
import { validate } from "../middleware/validate.js";
import { agentSetupProgressService } from "../services/agent-setup-progress.js";
import { workloadIdentityPublicOrigin } from "../services/workload-identity.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

const idSchema = z.string().uuid();

/**
 * The agent's side of a setup checklist. A person's own agent (outside
 * Paperclip) calls these with the bearer token from the setup prompt; they
 * need no Paperclip sign-in, so the token is the only credential and it can
 * only write to this one checklist.
 */
export function agentSetupProgressAgentRoutes(db: Db) {
  const router = Router();
  const service = agentSetupProgressService(db);
  const progressId = (req: Request) => {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) throw notFound("Setup progress not found");
    return parsed.data;
  };
  router.put("/api/agent-setup-progress/:id/checklist", validate(setAgentSetupChecklistSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await service.setChecklist(progressId(req), req.header("authorization"), req.body));
  });
  router.post("/api/agent-setup-progress/:id/items/:key", validate(updateAgentSetupItemSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const key = String(req.params.key);
    if (!agentSetupItemKeyPattern.test(key)) throw notFound("Checklist item not found");
    res.json(await service.updateItem(progressId(req), key, req.header("authorization"), req.body));
  });
  router.post("/api/agent-setup-progress/:id/finish", validate(finishAgentSetupSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await service.finish(progressId(req), req.header("authorization"), req.body));
  });
  return router;
}

/** The address the agent should call: the instance's public address, else the one the page used. */
function agentOrigin(req: Request) {
  return workloadIdentityPublicOrigin() ?? `${req.protocol}://${req.get("host")}`;
}

/**
 * The page's side. A checklist describes the setup of one thing (for AWS, one
 * connection), so only someone who may configure that thing creates one, and
 * only the person who started the setup reads it back.
 */
export function agentSetupProgressBoardRoutes(db: Db) {
  const router = Router();
  const service = agentSetupProgressService(db);
  const access = accessService(db);

  /** Same rule as configuring the connection: its creator, a connection manager, the local board or an instance admin. */
  async function assertCanSetUpSubject(req: Request, companyId: string, body: CreateAgentSetupProgress) {
    if (body.purpose !== "aws_connection") return;
    if (!body.subjectId) throw unprocessable("Name the connection being set up.", { code: "agent_setup_progress_subject_required" });
    // A connection id is a UUID; anything else is simply not a connection (and must not reach the uuid column).
    if (!idSchema.safeParse(body.subjectId).success) throw notFound("Tool connection not found");
    const [connection] = await db.select({ createdByUserId: toolConnections.createdByUserId }).from(toolConnections)
      .where(and(eq(toolConnections.id, body.subjectId), eq(toolConnections.companyId, companyId)));
    if (!connection) throw notFound("Tool connection not found");
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = connectionRequestUserId(req);
    if (userId && connection.createdByUserId === userId) return;
    if (userId && await access.hasPermission(companyId, "user", userId, "tools:manage_connections")) return;
    throw forbidden("Only the connection creator or a connection manager can set up this connection");
  }
  router.post("/companies/:companyId/agent-setup-progress", validate(createAgentSetupProgressSchema), async (req, res) => {
    assertBoard(req);
    const companyId = idSchema.parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const body = req.body as CreateAgentSetupProgress;
    await assertCanSetUpSubject(req, companyId, body);
    const { actorId } = getActorInfo(req);
    // The response carries the agent's token: never cache it.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.status(201).json(await service.create({
      companyId, purpose: body.purpose, subjectId: body.subjectId ?? null, userId: actorId, origin: agentOrigin(req),
    }));
  });
  router.get("/agent-setup-progress/:id", async (req, res) => {
    assertBoard(req);
    const id = idSchema.safeParse(req.params.id);
    // Another company's checklist, or another person's, answers exactly like a missing one.
    const progress = await getAccessibleResource(req, res, id.success ? service.get(id.data) : null, "Setup progress not found");
    if (!progress) return;
    const { actorId } = getActorInfo(req);
    const unrestricted = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;
    if (!unrestricted && progress.createdByUserId !== actorId) {
      res.status(404).json({ error: "Setup progress not found" });
      return;
    }
    const { createdByUserId: _creator, ...visible } = progress;
    res.json(visible);
  });
  return router;
}

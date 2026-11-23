import { Router, type Request } from "express";
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
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentSetupProgressService } from "../services/agent-setup-progress.js";
import { workloadIdentityPublicOrigin } from "../services/workload-identity.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

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

/** The page's side: board members create a checklist for their agent and read it. */
export function agentSetupProgressBoardRoutes(db: Db) {
  const router = Router();
  const service = agentSetupProgressService(db);
  router.post("/companies/:companyId/agent-setup-progress", validate(createAgentSetupProgressSchema), async (req, res) => {
    assertBoard(req);
    const companyId = idSchema.parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const body = req.body as CreateAgentSetupProgress;
    const { actorId } = getActorInfo(req);
    res.status(201).json(await service.create({
      companyId, purpose: body.purpose, subjectId: body.subjectId ?? null, userId: actorId, origin: agentOrigin(req),
    }));
  });
  router.get("/agent-setup-progress/:id", async (req, res) => {
    assertBoard(req);
    const id = idSchema.safeParse(req.params.id);
    const progress = id.success ? await service.get(id.data) : null;
    if (!progress) throw notFound("Setup progress not found");
    assertCompanyAccess(req, progress.companyId);
    res.json(progress);
  });
  return router;
}

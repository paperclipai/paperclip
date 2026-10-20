import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agentCommentaryQuerySchema, isUuidLike } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { submitAgentCommentary } from "../services/agent-commentary.js";
import { agentCommentaryReader } from "../services/agent-commentary-reader.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { accessService } from "../services/access.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function agentCommentaryRoutes(db: Db) {
  const router = Router();
  const reader = agentCommentaryReader(db);
  const access = accessService(db);

  async function authorizeRead(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin
      && (!req.actor.userId || !await access.canUser(companyId, req.actor.userId, "commentary:view"))) {
      throw forbidden("Missing permission: commentary:view");
    }
    return issueReadSqlCondition(db, req.actor);
  }

  router.get("/companies/:companyId/agent-commentary", async (req, res) => {
    const companyId = req.params.companyId as string;
    const readCondition = await authorizeRead(req, companyId);
    const query = agentCommentaryQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid agent commentary filters", query.error.issues);
    res.json(await reader.list(companyId, query.data, readCondition));
  });

  router.get("/companies/:companyId/agent-commentary/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const readCondition = await authorizeRead(req, companyId);
    const id = req.params.id as string;
    if (!isUuidLike(id)) throw notFound("Commentary not found");
    const entry = await reader.get(companyId, id, readCondition);
    if (!entry) throw notFound("Commentary not found");
    res.json(entry);
  });
  router.post("/companies/:companyId/agent-commentary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) {
      throw forbidden("Feedback requires an authenticated agent run");
    }
    const result = await submitAgentCommentary(db, {
      companyId, agentId: req.actor.agentId, runId: req.actor.runId, agentApiKeyId: req.actor.keyId,
    }, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  return router;
}

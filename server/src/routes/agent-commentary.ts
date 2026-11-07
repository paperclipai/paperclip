import { Router, type Request } from "express";
import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
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
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      // Agents can submit commentary but never read it. Name the human page so
      // an agent can send the person somewhere useful instead of a dead end.
      const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId)).limit(1);
      throw forbidden("Board access required", company ? {
        remediation: `Agent commentary is readable only by people with commentary access. Send the person to /${company.issuePrefix}/activity/commentary.`,
      } : undefined);
    }
    assertBoard(req);
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

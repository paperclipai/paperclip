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

  // Agents can submit commentary. They read only their own entries unless they
  // hold commentary:view, which no agent has by default. A denial names the
  // human page so the agent can send the person somewhere useful.
  async function denyAgentRead(companyId: string): Promise<never> {
    const [company] = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId)).limit(1);
    throw forbidden("Board access required", company ? {
      remediation: `Agents read only their own commentary unless granted commentary:view. People with commentary access can read it on the Commentary page; give them this link: [Commentary](/${company.issuePrefix}/activity/commentary).`,
    } : undefined);
  }

  async function agentCanReadAll(req: Request, companyId: string) {
    return req.actor.type === "agent" && !!req.actor.agentId
      && await access.hasPermission(companyId, "agent", req.actor.agentId, "commentary:view");
  }

  async function authorizeBoardRead(req: Request, companyId: string) {
    assertBoard(req);
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin
      && (!req.actor.userId || !await access.canUser(companyId, req.actor.userId, "commentary:view"))) {
      throw forbidden("Missing permission: commentary:view");
    }
    return issueReadSqlCondition(db, req.actor);
  }

  router.get("/companies/:companyId/agent-commentary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = agentCommentaryQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid agent commentary filters", query.error.issues);
    if (req.actor.type === "agent") {
      // Without the grant, only an explicit request for its own entries is allowed.
      if (!await agentCanReadAll(req, companyId) && query.data.agentId !== req.actor.agentId) await denyAgentRead(companyId);
      res.json(await reader.list(companyId, query.data, await issueReadSqlCondition(db, req.actor)));
      return;
    }
    if (req.actor.type !== "board") await denyAgentRead(companyId);
    res.json(await reader.list(companyId, query.data, await authorizeBoardRead(req, companyId)));
  });

  router.get("/companies/:companyId/agent-commentary/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    if (req.actor.type === "agent") {
      const entry = isUuidLike(id) ? await reader.get(companyId, id, await issueReadSqlCondition(db, req.actor)) : null;
      if (!await agentCanReadAll(req, companyId) && entry?.agent.id !== req.actor.agentId) await denyAgentRead(companyId);
      if (!entry) throw notFound("Commentary not found");
      res.json(entry);
      return;
    }
    if (req.actor.type !== "board") await denyAgentRead(companyId);
    const readCondition = await authorizeBoardRead(req, companyId);
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

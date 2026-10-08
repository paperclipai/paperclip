import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden, HttpError } from "../errors.js";
import { publicMcpConfig, McpOAuthError } from "../services/public-mcp/oauth.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";

export function dotRunnerRoutes(db: Db, resourceUrl?: string) {
  const router = Router();
  const broker = dotRunnerBroker(db);
  const path = "/companies/:companyId/agents/:agentId/dot-binding";
  function scope(req: Request, write = false) {
    const companyId = z.uuid().parse(req.params.companyId);
    const agentId = z.uuid().parse(req.params.agentId);
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (write && (!req.actor.userId || !["session", "cloud_tenant"].includes(req.actor.source ?? "")
        || req.actor.memberships?.find(m => m.companyId === companyId)?.membershipRole === "viewer")) {
      throw forbidden("Sign in as an operator to connect a Dot agent.");
    }
    return { companyId, agentId, operatorId: req.actor.userId! };
  }
  router.get(path, async (req, res) => {
    const input = scope(req);
    const config = resourceUrl ? null : publicMcpConfig(process.env);
    res.json({ enabled: await broker.enabled(), resourceUrl: resourceUrl ?? (config ? config.origin + "/mcp/runner" : null), binding: await broker.bindingForAgent(input.companyId, input.agentId) });
  });
  router.post(path, async (req, res) => {
    const input = scope(req, true);
    const body = z.object({ dotUrl: z.string().max(2048).optional() }).strict().parse(req.body ?? {});
    res.status(201).json(await broker.createPairing({ ...input, ...body }));
  });
  router.post(path + "/event-test", async (req, res) => {
    const input = scope(req, true); res.json(await broker.challenge(input.companyId, input.agentId));
  });
  router.delete(path, async (req, res) => {
    const input = scope(req, true); await broker.revoke(input.companyId, input.agentId, input.operatorId); res.status(204).end();
  });
  router.use((error: unknown, _req: Request, _res: unknown, next: (error: unknown) => void) => {
    next(error instanceof McpOAuthError ? new HttpError(error.status, error.message) : error);
  });
  return router;
}

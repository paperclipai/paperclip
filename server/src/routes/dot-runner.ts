import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden, HttpError } from "../errors.js";
import { publicMcpConfig, McpOAuthError } from "../services/public-mcp/oauth.js";
import { dotInvitationService } from "../services/dot-invitations.js";
import { agentService } from "../services/agents.js";
import { notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";

export function dotRunnerRoutes(db: Db, resourceUrl?: string) {
  const router = Router();
  const broker = dotRunnerBroker(db);
  const path = "/companies/:companyId/agents/:agentId/dot-binding";
  function companyScope(req: Request, write = false) {
    const companyId = z.uuid().parse(req.params.companyId);
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (write && (!req.actor.userId || !["session", "cloud_tenant"].includes(req.actor.source ?? "")
        || req.actor.memberships?.find(m => m.companyId === companyId)?.membershipRole === "viewer")) {
      throw forbidden("Sign in as an operator to connect a Dot agent.");
    }
    return { companyId, operatorId: req.actor.userId! };
  }
  function scope(req: Request, write = false) {
    return { ...companyScope(req, write), agentId: z.uuid().parse(req.params.agentId) };
  }
  const invitations = dotInvitationService(db);
  const invitePath = "/companies/:companyId/dot-invitations";
  async function inviteScope(req: Request) {
    const input = companyScope(req, true);
    const decision = await accessService(db).decide({ actor: req.actor, action: "agents:create", resource: { type: "company", companyId: input.companyId } });
    if (!decision.allowed) throw forbidden(decision.explanation);
    return input;
  }
  router.get(invitePath, async (req, res) => {
    const { companyId, operatorId } = await inviteScope(req);
    res.set("Cache-Control", "no-store").json(await invitations.resume(companyId, operatorId));
  });
  router.post(invitePath, async (req, res) => {
    const { companyId, operatorId } = await inviteScope(req);
    z.object({}).strict().parse(req.body ?? {});
    res.set("Cache-Control", "no-store").json(await invitations.create(companyId, operatorId));
  });
  router.get(path, async (req, res) => {
    const input = scope(req);
    const agent = await agentService(db).getById(input.agentId);
    if (!agent || agent.companyId !== input.companyId) throw notFound("Agent not found");
    const config = resourceUrl ? null : publicMcpConfig(process.env);
    res.json({ agentStatus: agent.status, enabled: await broker.enabled(), resourceUrl: resourceUrl ?? (config ? config.origin + "/mcp/runner" : null), binding: await broker.bindingForAgent(input.companyId, input.agentId) });
  });
  router.post(path, async (req, res) => {
    const input = scope(req, true);
    const body = z.object({ dotUrl: z.string().max(2048).optional(), replaceBindingId: z.uuid().optional() }).strict().parse(req.body ?? {});
    res.set("Cache-Control", "no-store").status(201).json(await broker.createPairing({ ...input, ...body }));
  });
  router.post(path + "/event-test", async (req, res) => {
    const input = scope(req, true);
    const body = z.object({ bindingId: z.uuid().optional() }).strict().parse(req.body ?? {});
    res.json(await broker.challenge(input.companyId, input.agentId, { bindingId: body.bindingId }));
  });
  router.delete(path, async (req, res) => {
    const input = scope(req, true); await broker.revoke(input.companyId, input.agentId, input.operatorId); res.status(204).end();
  });
  router.use((error: unknown, _req: Request, _res: unknown, next: (error: unknown) => void) => {
    next(error instanceof McpOAuthError ? new HttpError(error.status, error.message) : error);
  });
  return router;
}

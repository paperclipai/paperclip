import { Router, type Request } from "express";
import { z } from "zod";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { createGrokInvitationSchema, configureGrokRoutineSchema, verifyGrokRoutineSchema, recoverGrokRoutineSchema, pairGrokBindingSchema, stopGrokWorkSchema, retryGrokDeliverySchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden, HttpError, notFound } from "../errors.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { agentService } from "../services/agents.js";
import { authorizeExternalBotOperator } from "../services/external-bot-authority.js";
import { dotRunnerBroker } from "../services/dot-runner-broker.js";
import { dotInvitationService } from "../services/dot-invitations.js";
import { grokRoutineService } from "../services/grok-bot/routine.js";
import { McpOAuthError } from "../services/public-mcp/oauth.js";
import { canConfigureAgentConnection } from "../modules/agent-lifecycle/index.js";

export function grokBotRoutes(db: Db, resourceUrl: string) {
  const router = Router(), broker = dotRunnerBroker(db), routines = grokRoutineService(db);
  const invitations = dotInvitationService(db, "grok_bot");
  const path = "/companies/:companyId/agents/:agentId/grok-binding";
  async function companyScope(req: Request, write = false) {
    const companyId = z.uuid().parse(req.params.companyId);
    assertBoard(req); assertCompanyAccess(req, companyId);
    const operatorId = req.actor.userId;
    if (!operatorId || write && !["session", "cloud_tenant"].includes(req.actor.source ?? "")) throw forbidden("Sign in to manage this Grok agent.");
    if (write) await authorizeExternalBotOperator(db, companyId, operatorId);
    return { companyId, operatorId };
  }
  async function scope(req: Request, write = false) {
    const input = { ...await companyScope(req, write), agentId: z.uuid().parse(req.params.agentId) };
    const agent = await agentService(db).getById(input.agentId);
    if (!agent || agent.companyId !== input.companyId || agent.adapterType !== "paperclip_runner" || agent.adapterConfig.provider !== "grok_bot") throw notFound("Grok agent not found");
    return { ...input, agent };
  }
  router.get("/companies/:companyId/grok-invitations", async (req, res) => {
    const { companyId, operatorId } = await companyScope(req, true);
    res.set("Cache-Control", "no-store").json(await invitations.resume(companyId, operatorId));
  });
  router.post("/companies/:companyId/grok-invitations", async (req, res) => {
    const { companyId, operatorId } = await companyScope(req, true);
    const details = createGrokInvitationSchema.parse(req.body);
    if (details.reportsTo) { const manager = await agentService(db).getById(details.reportsTo); if (!manager || manager.companyId !== companyId || manager.status === "terminated") throw notFound("Manager not found"); }
    res.set("Cache-Control", "no-store").status(201).json(await invitations.create(companyId, operatorId, details));
  });
  router.get(path, async (req, res) => {
    const { companyId, agentId, agent } = await scope(req);
    const binding = await broker.bindingForAgent(companyId, agentId);
    const readable = await issueReadSqlCondition(db, req.actor);
    const [queued] = await db.select({ count: sql<number>`count(*)::int` }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId), eq(issues.status, "todo"), readable));
    const [currentTask] = binding?.assignment ? await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title }).from(heartbeatRuns)
      .innerJoin(issues, and(eq(issues.id, heartbeatRuns.nativeIssueId), eq(issues.companyId, companyId)))
      .where(and(eq(heartbeatRuns.id, binding.assignment.runId), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.companyId, companyId), readable)) : [];
    res.set("Cache-Control", "no-store").json({ queuedTaskCount: queued?.count ?? 0, currentTask: currentTask ?? null, enabled: resourceUrl.startsWith("https://") && await broker.enabled("grok_bot"), resourceUrl,
      agentStatus: agent.status, agentLifecycleState: agent.lifecycleState, recoveryNeeded: await routines.recoveryNeeded(companyId, agentId), canConfigureConnection: canConfigureAgentConnection(agent),
      binding });
  });
  router.post(path, async (req, res) => {
    const { companyId, agentId, operatorId } = await scope(req, true);
    if (!resourceUrl.startsWith("https://")) throw forbidden("Grok Bot requires an authenticated public HTTPS instance.");
    const body = pairGrokBindingSchema.parse(req.body ?? {});
    res.set("Cache-Control", "no-store").status(201).json(await broker.createPairing({ companyId, agentId, operatorId, provider: "grok_bot", ...body }));
  });
  router.put(path + "/routine", async (req, res) => {
    const { companyId, agentId, operatorId } = await scope(req, true);
    const body = configureGrokRoutineSchema.parse(req.body);
    res.set("Cache-Control", "no-store").json(await routines.configure({ companyId, agentId, operatorId, ...body }));
  });
  router.post(path + "/verify", async (req, res) => {
    const { companyId, agentId } = await scope(req, true);
    const { bindingId, requestId } = verifyGrokRoutineSchema.parse(req.body);
    const intent = await routines.reserve({ companyId, agentId, bindingId, sourceEventId: `verify:${requestId}`, kind: "verify" });
    res.set("Cache-Control", "no-store").json(await routines.send(companyId, agentId, intent.id));
  });
  router.post(path + "/retry", async (req, res) => {
    const { companyId, agentId, operatorId } = await scope(req, true);
    const { correlationId } = retryGrokDeliverySchema.parse(req.body);
    res.set("Cache-Control", "no-store").json(await routines.retryRejected(companyId, agentId, operatorId, correlationId));
  });
  router.post(path + "/stop", async (req, res) => {
    const { companyId, agentId, operatorId } = await scope(req, true);
    const { expectedRunId } = stopGrokWorkSchema.parse(req.body ?? {});
    res.set("Cache-Control", "no-store").json(await broker.stopGrokWork(companyId, agentId, operatorId, expectedRunId));
  });
  router.post(path + "/recover", async (req, res) => {
    const { companyId, agentId, operatorId } = await scope(req, true);
    recoverGrokRoutineSchema.parse(req.body);
    res.set("Cache-Control", "no-store").json(await routines.recover(companyId, agentId, operatorId));
  });
  router.delete(path, async (req, res) => {
    const { companyId, agentId, operatorId } = await scope(req, true);
    await broker.revoke(companyId, agentId, operatorId); res.status(204).end();
  });
  router.use((error: unknown, _req: Request, _res: unknown, next: (error: unknown) => void) => next(error instanceof McpOAuthError ? new HttpError(error.status, error.message) : error));
  return router;
}

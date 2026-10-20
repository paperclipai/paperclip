import { validateAiApiKey } from "../services/ai-api-key-test.js";
export { validateAiApiKey } from "../services/ai-api-key-test.js";
import { supportsLocalAiLogin } from "../services/local-ai-login-policy.js";
import { localAiLoginService } from "../services/local-ai-login.js";
import { z } from "zod";
import { Router, type Request } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type Db,
  adapterAuthSessions,
  heartbeatRuns,
  toolConnections,
  connectionGrants,
  agents,
} from "@paperclipai/db";
import {
  createAiConnectionSchema,
  aiConnectionLoginIntentSchema,
  localAiConnectionSchema,
  localAiLoginStartSchema,
  browserCodeSchema,
  isAiConnectionCompatible,
  type AiConnectionLoginIntent,
  type AiProvider,
  type AiConnectionBinding,
  type AiConnectionList,
  aiConnectionPoolConfigSchema,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { aiConnectionRouterService } from "../services/ai-connection-router.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { validate } from "../middleware/validate.js";
import { probeCopilotConnection } from "../services/copilot-connection-probe.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

/** Agent API calls inherit authenticated run identity, never the agent's own ID. */
export function responsibleUserForAiRequest(req: Request): string | null {
  return req.actor.type === "agent"
    ? req.actor.onBehalfOfUserId ?? null
    : getActorInfo(req).actorId;
}

export async function canManageAiConnections(db: Db, req: Request, companyId: string): Promise<boolean> {
  const membership = req.actor.memberships?.find((m) => m.companyId === companyId && m.status === "active");
  if (membership?.membershipRole === "viewer") return false;
  return req.actor.source === "local_implicit" || Boolean(req.actor.isInstanceAdmin)
    || membership?.membershipRole === "owner" || membership?.membershipRole === "admin"
    || await accessService(db).hasPermission(companyId, "user", getActorInfo(req).actorId, "tools:manage_connections");
}

export async function assertAiConnectionCreateAccess(
  db: Db,
  req: Request,
  companyId: string,
  input: Pick<
    AiConnectionLoginIntent,
    "ownership" | "allAgents" | "agentIds" | "connectionId"
  >,
) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  const actor = getActorInfo(req);
  const userId = actor.actorId;
  if (input.connectionId) {
    const [grant] = await db
      .select({
        owner: connectionGrants.subjectUserId,
        creator: toolConnections.createdByUserId,
      })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        eq(toolConnections.id, connectionGrants.connectionId),
      )
      .where(
        and(
          eq(toolConnections.id, input.connectionId),
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.connectionPurpose, "ai"),
        ),
      )
      .limit(1);
    if (!grant || (grant.owner ?? grant.creator) !== userId)
      throw forbidden(
        "Only the account owner can reconnect this AI connection",
      );
  }
  const membership = req.actor.memberships?.find(
    (m) => m.companyId === companyId && m.status === "active",
  );
  const manager = await canManageAiConnections(db, req, companyId);
  if (
    !input.connectionId &&
    !manager &&
    (input.ownership === "shared" || input.allAgents)
  )
    throw forbidden(
      "A connection manager must authorize company-shared access",
    );
  if (!input.connectionId && !manager && input.agentIds.length) {
    for (const id of input.agentIds) {
      if (
        !(
          await accessService(db).decide({
            actor: { type: "board", userId },
            action: "agent_config:update",
            resource: { type: "agent", companyId, agentId: id },
          })
        ).allowed
      )
        throw forbidden("You cannot configure this agent");
    }
  }
  if (membership?.membershipRole === "viewer")
    throw forbidden("Viewers cannot create AI connections");
  return userId;
}

/** Creating an agent may install a shared connection only with the existing
 * connection-configure authority. An agent actor cannot grant itself access. */
export async function canInstallSharedAiConnectionForNewAgent(
  db: Db, req: Request, companyId: string, binding: AiConnectionBinding,
): Promise<boolean> {
  if (req.actor.type !== "board" || binding.mode !== "shared") return false;
  assertCompanyAccess(req, companyId);
  const member = req.actor.memberships?.find(m => m.companyId === companyId && m.status === "active");
  if (member?.membershipRole === "viewer") return false;
  const userId = getActorInfo(req).actorId;
  const [connection] = await db.select({ creator: toolConnections.createdByUserId })
    .from(toolConnections).where(and(eq(toolConnections.companyId, companyId),
      eq(toolConnections.id, binding.connectionId), eq(toolConnections.connectionPurpose, "ai")));
  if (!connection) return false;
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true ||
    connection.creator === userId || await accessService(db).hasPermission(companyId, "user", userId, "tools:manage_connections");
}


export function aiConnectionRoutes(db: Db, options: Parameters<typeof supportsLocalAiLogin>[0] & { pluginWorkerManager?: PluginWorkerManager } = {}) {
  function assertLocalLoginAvailable() {
    if (!supportsLocalAiLogin(options)) throw unprocessable("Server-host subscription sign-in is unavailable on this hosted instance. Choose a supported sign-in environment or use an API key.");
  }
  const router = Router();
  const service = aiConnectionService(db);
  const localLogin = localAiLoginService(db);
  const pools = aiConnectionRouterService(db);
  router.get("/companies/:companyId/ai-connection-pools", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    res.setHeader("Cache-Control", "no-store");
    res.json(await pools.list(companyId));
  });
  router.get("/companies/:companyId/ai-connection-pools/:poolId/inspection", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    res.setHeader("Cache-Control", "no-store");
    res.json(await pools.inspect(companyId, z.string().uuid().parse(req.params.poolId), getActorInfo(req).actorId));
  });
  router.post("/companies/:companyId/ai-connection-pools", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    const body = z.object({ pluginKey: z.string().min(1).max(160), id: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(), config: aiConnectionPoolConfigSchema }).strict().parse(req.body);
    res.json(await pools.save(body.pluginKey, { ...body, companyId }, getActorInfo(req).actorId));
  });
  router.delete("/companies/:companyId/ai-connection-pools/:poolId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req); assertCompanyAccess(req, companyId);
    if (!(await canManageAiConnections(db, req, companyId))) throw forbidden("Manage connections permission is required");
    const poolId = z.string().uuid().parse(req.params.poolId);
    const { expectedRevision } = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(req.body);
    res.json(await pools.remove(companyId, poolId, expectedRevision, getActorInfo(req).actorId));
  });
  function assertLocalOperator(req: Request) {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    if (req.actor.source !== "local_implicit")
      throw forbidden("Only the local operator can connect this machine's CLI account.");
  }
  router.post("/companies/:companyId/ai-connections/local/attempts", validate(localAiLoginStartSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { restart, ...intent } = localAiLoginStartSchema.parse(req.body);
    assertLocalLoginAvailable();
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(await localLogin.start(companyId, userId, intent, restart));
  });
  router.post("/companies/:companyId/ai-connections/local/check", validate(localAiConnectionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const { localSessionId, ...intent } = localAiConnectionSchema.parse(req.body);
    assertLocalLoginAvailable();
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.setHeader("Cache-Control", "no-store");
    res.json(await localLogin.check(companyId, userId, intent, localSessionId));
  });
  router.delete("/companies/:companyId/ai-connections/local/attempts/:sessionId", async (req, res) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    const id = z.string().uuid().parse(req.params.sessionId);
    await localLogin.cancel(req.params.companyId as string, getActorInfo(req).actorId, id);
    res.json({ ok: true });
  });
  router.post("/companies/:companyId/ai-connections/local/attempts/:sessionId/code", validate(z.object({ browserCode: browserCodeSchema })), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertLocalLoginAvailable();
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const id = z.string().uuid().parse(req.params.sessionId);
    await localLogin.submitCode(companyId, getActorInfo(req).actorId, id, browserCodeSchema.parse(req.body.browserCode));
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });
  router.get("/companies/:companyId/ai-connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const currentUserId = getActorInfo(req).actorId;
    res.setHeader("Cache-Control", "no-store");
    const agentId = req.query.agentId;
    if (agentId !== undefined && !z.string().uuid().safeParse(agentId).success)
      throw unprocessable("Invalid agent ID");
    res.json({
      currentUserId,
      pools: await pools.selectable(companyId, currentUserId),
      canManageConnections: await canManageAiConnections(db, req, companyId),
      connections: await service.list(
        companyId,
        currentUserId,
        agentId as string | undefined,
      ),
    } satisfies AiConnectionList);
  });
  router.get(
    "/companies/:companyId/ai-connections/:connectionId/usage",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const connectionId = z.string().uuid().safeParse(req.params.connectionId);
      const grantId = z.string().uuid().optional().safeParse(req.query.grantId);
      if (!connectionId.success || !grantId.success) throw unprocessable("Invalid connection or grant ID");
      res.setHeader("Cache-Control", "no-store");
      res.json(await service.probeUsage(companyId, getActorInfo(req).actorId, connectionId.data, grantId.data));
    },
  );
  router.get(
    "/companies/:companyId/ai-connections/:connectionId/active-runs",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      if (!z.string().uuid().safeParse(req.params.connectionId).success)
        throw unprocessable("Invalid connection ID");
      const [connection] = await db
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.id, req.params.connectionId as string),
            eq(toolConnections.connectionPurpose, "ai"),
          ),
        );
      if (!connection || !(await service.list(companyId, getActorInfo(req).actorId)).some(account => account.id === connection.id))
        throw notFound("AI connection not found");
      res.setHeader("Cache-Control", "no-store");
      res.json(
        await db
          .select({
            id: heartbeatRuns.id,
            agentId: agents.id,
            agentName: agents.name,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
              sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId' = ${connection.id}`,
            ),
          ),
      );
    },
  );
  router.post(
    "/companies/:companyId/ai-connections",
    validate(createAiConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const input = createAiConnectionSchema.parse(req.body);
      const userId = await assertAiConnectionCreateAccess(
        db,
        req,
        companyId,
        input,
      );
      if (input.method !== "api_key")
        throw unprocessable(
          "Use the existing provider sign-in flow to connect a subscription",
        );
      const attemptStartedAt = new Date();
      if (input.provider === "github") {
        if (!input.apiKey?.startsWith("github_pat_")) throw unprocessable("Use a personal fine-grained token with Copilot Requests permission.", { code: "COPILOT_AUTH_REQUIRED" });
        await probeCopilotConnection(db, companyId, input.apiKey, input.environmentId, undefined, { pluginWorkerManager: options.pluginWorkerManager });
      } else if (!input.routing || input.routing.kind === "openrouter") await validateAiApiKey(input.provider, input.apiKey!);
      const result = await service.save(
        companyId,
        userId,
        input,
        input.apiKey ?? "",
        undefined,
        attemptStartedAt,
      );
      res.status(201).json(result);
    },
  );
  router.post(
    "/companies/:companyId/ai-connections/local",
    validate(localAiConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const { localSessionId, ...input } = localAiConnectionSchema.parse(req.body);
      assertLocalLoginAvailable();
      const userId = await assertAiConnectionCreateAccess(db, req, companyId, input);
      if (!localSessionId) throw unprocessable(input.provider === "xai"
        ? "Start local sign-in for this connection before connecting."
        : "Start browser sign-in for this connection before connecting.");
      res.status(201).json(await localLogin.complete(companyId, userId, localSessionId, input));
    },
  );
  router.put(
    "/companies/:companyId/ai-connections/default",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const userId = getActorInfo(req).actorId;
      if (
        req.actor.memberships?.some(
          (m) => m.companyId === companyId && m.membershipRole === "viewer",
        )
      )
        throw forbidden("Viewers cannot change defaults");
      if (!z.string().uuid().safeParse(req.body.grantId).success)
        throw unprocessable("Choose a personal connection");
      await service.setDefault(companyId, userId, req.body.grantId);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "ai_connection.default_changed",
        entityType: "connection_grant",
        entityId: req.body.grantId,
      });
      res.json({ ok: true });
    },
  );
  router.get(
    "/companies/:companyId/ai-connections/login/:sessionId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const [session] = await db
        .select({
          connectionId: adapterAuthSessions.connectionId,
          grantId: adapterAuthSessions.connectionGrantId,
        })
        .from(adapterAuthSessions)
        .where(
          and(
            eq(adapterAuthSessions.companyId, companyId),
            eq(adapterAuthSessions.startedByUserId, getActorInfo(req).actorId),
            eq(
              adapterAuthSessions.publicSessionId,
              req.params.sessionId as string,
            ),
          ),
        );
      if (!session?.connectionId)
        throw notFound("The login has not saved a connection");
      res.setHeader("Cache-Control", "no-store");
      res.json(session);
    },
  );
  return router;
}

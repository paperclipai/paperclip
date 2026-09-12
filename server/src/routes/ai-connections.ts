import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";
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
  isAiConnectionCompatible,
  type AiConnectionLoginIntent,
  type AiProvider,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { validate } from "../middleware/validate.js";

/** Agent API calls inherit authenticated run identity, never the agent's own ID. */
export function responsibleUserForAiRequest(req: Request): string | null {
  return req.actor.type === "agent"
    ? req.actor.onBehalfOfUserId ?? null
    : getActorInfo(req).actorId;
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
  const manager =
    req.actor.source === "local_implicit" ||
    req.actor.isInstanceAdmin ||
    membership?.membershipRole === "owner" ||
    membership?.membershipRole === "admin" ||
    (await accessService(db).hasPermission(
      companyId,
      "user",
      userId,
      "tools:manage_connections",
    ));
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

/** Fixed provider endpoints; credentials are never sent to a caller-supplied URL or through a redirect. */
export async function validateAiApiKey(
  provider: AiProvider,
  key: string,
  request: typeof fetch = fetch,
) {
  const endpoints = {
    anthropic: "https://api.anthropic.com/v1/models?limit=1",
    openai: "https://api.openai.com/v1/models",
    openrouter: "https://openrouter.ai/api/v1/key",
    xai: "https://api.x.ai/v1/models",
  };
  let response: Response;
  try {
    response = await request(endpoints[provider], {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers:
        provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key}` },
    });
  } catch {
    throw unprocessable("Could not verify the account. Try again.");
  }
  await response.body?.cancel();
  if (!response.ok)
    throw unprocessable(
      response.status === 401 || response.status === 403
        ? "The provider rejected this API key."
        : "The provider could not verify this account. Try again.",
    );
}

export function aiConnectionRoutes(db: Db) {
  const router = Router();
  const service = aiConnectionService(db);
  const localLogin = localAiLoginService(db);
  function assertLocalOperator(req: Request) {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    if (req.actor.source !== "local_implicit")
      throw forbidden("Only the local operator can connect this machine's CLI account.");
  }
  router.post("/companies/:companyId/ai-connections/local/attempts", validate(localAiLoginStartSchema), async (req, res) => {
    assertLocalOperator(req);
    const companyId = req.params.companyId as string;
    const { restart, ...intent } = localAiLoginStartSchema.parse(req.body);
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.status(201).json(await localLogin.start(companyId, userId, intent, restart));
  });
  router.post("/companies/:companyId/ai-connections/local/check", validate(localAiConnectionSchema), async (req, res) => {
    assertLocalOperator(req);
    const companyId = req.params.companyId as string;
    const { localSessionId, ...intent } = localAiConnectionSchema.parse(req.body);
    const userId = await assertAiConnectionCreateAccess(db, req, companyId, intent);
    res.setHeader("Cache-Control", "no-store");
    res.json(await localLogin.check(companyId, userId, intent, localSessionId));
  });
  router.delete("/companies/:companyId/ai-connections/local/attempts/:sessionId", async (req, res) => {
    assertLocalOperator(req);
    const id = z.string().uuid().parse(req.params.sessionId);
    await localLogin.cancel(req.params.companyId as string, getActorInfo(req).actorId, id);
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
      connections: await service.list(
        companyId,
        currentUserId,
        agentId as string | undefined,
      ),
    });
  });
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
      await validateAiApiKey(input.provider, input.apiKey!);
      const result = await service.save(
        companyId,
        userId,
        input,
        input.apiKey!,
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
      // A signed-in remote user must never claim the server operator's account.
      assertLocalOperator(req);
      const companyId = req.params.companyId as string;
      const { localSessionId, ...input } = localAiConnectionSchema.parse(req.body);
      const userId = await assertAiConnectionCreateAccess(db, req, companyId, input);
      if (input.provider === "openai" || input.provider === "xai") {
        if (!localSessionId) throw unprocessable("Start a separate local sign-in for this connection before connecting.");
        res.status(201).json(await localLogin.complete(companyId, userId, localSessionId, input));
        return;
      }
      const attemptStartedAt = new Date();
      const credential = await readVerifiedLocalAiCredential(input.provider);
      res.status(201).json(await service.save(companyId, userId, input, credential, undefined, attemptStartedAt));
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

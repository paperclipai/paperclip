import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  toolConnections,
  connectionGrants,
  companySecrets,
  toolConnectionInstalls,
} from "@paperclipai/db";
import type { EmailConnectionInput } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { secretService } from "./secrets.js";
import { toolAccessService } from "./tool-access.js";
import { agentmailApi } from "./agentmail-api.js";
import { logActivity } from "./activity-log.js";
import type { EmailActor } from "./email-channels.js";

export function emailConnectionService(
  db: Db,
  fetchImpl: typeof fetch = fetch,
) {
  const secrets = secretService(db);
  async function get(companyId: string, id: string, actor?: EmailActor) {
    const [connection] = await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.id, id),
          eq(toolConnections.status, "active"),
          eq(toolConnections.enabled, true),
        ),
      );
    if (!connection || connection.config.provider !== "agentmail")
      throw notFound("Active AgentMail connection not found");
    if (connection.config.emailCredential) {
      const id = connection.credentialSecretRefs.find((ref) => ref.configPath === "credentials.controlKey")?.secretId;
      const [secret] = id ? await db.select({ id: companySecrets.id }).from(companySecrets).where(and(
        eq(companySecrets.id, id), eq(companySecrets.companyId, companyId),
        eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt),
      )) : [];
      if (!secret) throw forbidden("AgentMail credential is unavailable");
    }
    const activeGrants = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.connectionId, id),
          eq(connectionGrants.status, "active"),
        ),
      );
    if (connection.config.emailCredential && !activeGrants.length)
      throw forbidden("AgentMail credential access has been revoked");
    if (actor && !actor.localImplicit) {
      const grants = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.connectionId, id),
            eq(connectionGrants.status, "active"),
          ),
        );
      if (
        !grants.some(
          (g) =>
            g.kind === "organization" ||
            (g.kind === "user" && g.subjectUserId === actor.userId),
        )
      )
        throw forbidden("You do not have access to this AgentMail credential");
    }
    return connection;
  }
  async function assertAgentAccess(
    companyId: string,
    id: string,
    agentId: string,
  ) {
    await get(companyId, id);
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, companyId),
          eq(toolConnectionInstalls.connectionId, id),
        ),
      );
    if (
      !installs.some(
        (i) =>
          (i.targetType === "company" && i.targetId === companyId) ||
          (i.targetType === "agent" && i.targetId === agentId),
      )
    )
      throw forbidden(
        "This agent no longer has access to the AgentMail connection",
      );
  }
  async function credential(companyId: string, id: string, actor?: EmailActor) {
    const connection = await get(companyId, id, actor);
    const ref = connection.credentialSecretRefs.find(
      (r) => r.configPath === "credentials.controlKey",
    );
    if (!ref) throw badRequest("Reconnect AgentMail to restore its API key");
    const value = await secrets.resolveSecretValue(
      companyId,
      ref.secretId,
      ref.versionSelector ?? "latest",
      {
        consumerType: "tool_connection",
        consumerId: id,
        configPath: ref.configPath,
        actorType: "system",
        actorId: null,
      },
    );
    return { connection, ref, value };
  }
  async function connect(
    companyId: string,
    input: EmailConnectionInput,
    actor: EmailActor,
  ) {
    await agentmailApi(input.apiKey, fetchImpl).whoami();
    return db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`email-account:${companyId}:${input.idempotencyKey}`}, 0))`,
      );
      const secrets = secretService(db);
      const tools = toolAccessService(db);
      for (const agentId of input.agentIds) {
        const [agent] = await db
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.id, agentId),
              eq(agents.companyId, companyId),
              ne(agents.status, "terminated"),
            ),
          );
        if (!agent) throw badRequest("Select an available company agent");
      }
      const previous = await db
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            eq(
              toolConnections.uid,
              `agentmail-account-${input.idempotencyKey}`,
            ),
          ),
        );
      if (previous[0])
        return emailConnectionService(db, fetchImpl).get(
          companyId,
          previous[0].id,
          actor,
        );
      const secret = await secrets.create(companyId, {
        name: `AgentMail account ${randomUUID()}`,
        provider: "local_encrypted",
        value: input.apiKey,
      });
      const app = await tools.createApplication(companyId, {
        name: `AgentMail ${input.idempotencyKey.slice(0, 8)}`,
        applicationKey: `agentmail-account:${input.idempotencyKey}`,
        type: "chat",
        status: "active",
        metadata: { sourceTemplateKey: "agentmail" },
      });
      const connection = await tools.createConnection(
        companyId,
        {
          applicationId: app.id,
          name: "AgentMail",
          connectionKind: "managed",
          connectionPurpose: "tool",
          transport: "rest_api",
          authKind: "api_key",
          ownership: "customer",
          credentialPolicy: "shared",
          enabled: true,
          status: "active",
          config: { provider: "agentmail", emailCredential: true },
          transportConfig: {},
          credentialSecretRefs: [
            {
              secretId: secret.id,
              configPath: "credentials.controlKey",
              versionSelector: "latest",
              required: true,
            },
          ],
        },
        {
          actorType: "user",
          actorId: actor.userId ?? "board",
          actorSource: actor.localImplicit ? "local_implicit" : "session",
        },
      );
      await db
        .update(toolConnections)
        .set({
          uid: `agentmail-account-${input.idempotencyKey}`,
          healthStatus: "ok",
          healthMessage: "Connected",
          healthCheckedAt: new Date(),
        })
        .where(eq(toolConnections.id, connection.id));
      if (input.grantKind === "user")
        await db
          .update(connectionGrants)
          .set({
            kind: "user",
            isDefault: false,
            subjectUserId: actor.userId ?? "board",
          })
          .where(eq(connectionGrants.connectionId, connection.id));
      await tools.putConnectionInstalls(
        connection.id,
        {
          installs: input.allAgents
            ? [{ targetType: "company", targetId: companyId }]
            : input.agentIds.map((targetId) => ({
                targetType: "agent" as const,
                targetId,
              })),
        },
        {
          actorType: "user",
          actorId: actor.userId ?? "board",
          actorSource: actor.localImplicit ? "local_implicit" : "session",
        },
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "email.connection.created",
        entityType: "tool_connection",
        entityId: connection.id,
        details: {
          grantKind: input.grantKind,
          allAgents: input.allAgents,
          agentIds: input.agentIds,
        },
      });
      return tools.getConnection(connection.id, companyId);
    });
  }
  async function allowAgent(
    companyId: string,
    id: string,
    agentId: string,
    actor: EmailActor,
  ) {
    return db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.id, id),
            eq(toolConnections.companyId, companyId),
          ),
        )
        .for("update");
      await emailConnectionService(db, fetchImpl).get(companyId, id, actor);
      const tools = toolAccessService(db);
      const installs = await db
        .select()
        .from(toolConnectionInstalls)
        .where(eq(toolConnectionInstalls.connectionId, id));
      if (
        installs.some(
          (i) => i.targetType === "company" || i.targetId === agentId,
        )
      )
        return;
      await tools.putConnectionInstalls(
        id,
        {
          installs: [
            ...installs.map((i) => ({
              targetType: i.targetType,
              targetId: i.targetId,
            })),
            { targetType: "agent", targetId: agentId },
          ],
        },
        {
          actorType: "user",
          actorId: actor.userId ?? "board",
          actorSource: actor.localImplicit ? "local_implicit" : "session",
        },
      );
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId ?? "board",
        action: "email.connection.agent_added",
        entityType: "tool_connection",
        entityId: id,
        details: { agentId },
      });
    });
  }
  return { get, credential, connect, allowAgent, assertAgentAccess };
}

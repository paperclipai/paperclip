import type { ActorInfo, DbTransaction, ToolAccessMutationDb } from "../types.js";
import { oauthConfig } from "./metadata.js";
import { syncConnectionCredentialBindings } from "../../connection-credential-bindings.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import type { ToolConnection, ToolCredentialSecretRef } from "@paperclipai/shared";
import { notFound } from "../../../errors.js";
import { secretService } from "../../secrets.js";
import { resolveConnectionGrantSecret, writeConnectionCredential } from "../../connection-credentials.js";

import { configuredOAuthClientForConnection, oauthSecretRef } from "./client-settings.js";
export function actorForSecret(
  actor?: ActorInfo,
): { userId?: string | null; agentId?: string | null } | undefined {
  if (actor?.actorType === "user") return { userId: actor.actorId ?? null };
  if (actor?.actorType === "agent") return { agentId: actor.actorId ?? null };
  return undefined;
}

export function createOAuthCredentialStore(db: Db, secrets: ReturnType<typeof secretService>) {
  /**
   * @param grantSecretRefs Secret refs held by a grant rather than the connection
   *   row. A personal credential lives only on its user grant (PAP-17835), so it
   *   would otherwise have no `company_secret_bindings` row and drop out of
   *   secret projection and removal teardown.
   */
async function syncCredentialBindings(
    connection: typeof toolConnections.$inferSelect,
    grantSecretRefs: ToolCredentialSecretRef[] = [],
    dbClient: ToolAccessMutationDb = db,
  ) {
    await syncConnectionCredentialBindings(db, connection, grantSecretRefs, dbClient);
  }

  async function annotateSavedOAuthClientSecret(connections: ToolConnection[], viewerUserId?: string) {
    const personal = connections.filter((connection) => connection.authKind === "oauth" && connection.credentialPolicy === "per_user");
    const grants = viewerUserId && personal.length > 0
      ? await db.select({ connectionId: connectionGrants.connectionId, refs: connectionGrants.credentialSecretRefs })
        .from(connectionGrants)
        .where(and(
          inArray(connectionGrants.companyId, [...new Set(personal.map((connection) => connection.companyId))]),
          inArray(connectionGrants.connectionId, personal.map((connection) => connection.id)),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, viewerUserId),
          eq(connectionGrants.status, "active"),
        ))
      : [];
    const savedPersonal = new Set(grants.filter((grant) => grant.refs.some((ref) => ref.configPath === "oauth.client_secret")).map((grant) => grant.connectionId));
    for (const connection of connections) {
      connection.hasSavedOAuthClientSecret = connection.credentialPolicy === "per_user"
        ? savedPersonal.has(connection.id)
        : connection.credentialSecretRefs.some((ref) => ref.configPath === "oauth.client_secret");
    }
  }

  async function oauthClientForConnection(
    connection: typeof toolConnections.$inferSelect,
    provider: string,
    actor?: ActorInfo,
  ) {
    const configured = configuredOAuthClientForConnection(connection, provider);
    if (configured.clientId) return configured;
    const oauth = oauthConfig(connection);
    const clientId =
      typeof oauth.clientId === "string" && oauth.clientId.trim()
        ? oauth.clientId.trim()
        : null;
    if (!clientId) return configured;
    // CIMD clients and public DCR clients have no token-endpoint secret. A DCR
    // authorization server may instead issue a confidential client (for
    // example, `client_secret_basic`); in that case the registration secret is
    // encrypted like every other provider credential and resolved only for the
    // token endpoint.
    const registrationSource = oauth.clientRegistrationSource;
    const publicRegisteredClient =
      registrationSource === "cimd" ||
      (registrationSource === "dcr" &&
        oauth.clientTokenEndpointAuthMethod === "none");
    let credentialSecretRefs = connection.credentialSecretRefs;
    if (
      connection.credentialPolicy === "per_user" &&
      actor?.actorType === "user" &&
      actor.actorId &&
      !credentialSecretRefs.some(
        (ref) => ref.configPath === "oauth.client_secret",
      )
    ) {
      const [personalGrant] = await db
        .select({
          credentialSecretRefs: connectionGrants.credentialSecretRefs,
        })
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, "user"),
            eq(connectionGrants.subjectUserId, actor.actorId),
            eq(connectionGrants.status, "active"),
          ),
        )
        .limit(1);
      credentialSecretRefs =
        personalGrant?.credentialSecretRefs ?? credentialSecretRefs;
    }
    const clientSecretRef = publicRegisteredClient
      ? undefined
      : credentialSecretRefs.find(
          (ref) => ref.configPath === "oauth.client_secret",
        );
    const clientSecret = clientSecretRef
      ? await secrets.resolveSecretValue(
          connection.companyId,
          clientSecretRef.secretId,
          clientSecretRef.versionSelector ?? "latest",
          {
            consumerType: "tool_connection",
            consumerId: connection.id,
            configPath: "oauth.client_secret",
            actorType: actor?.actorType ?? "system",
            actorId: actor?.actorId ?? null,
          },
        )
      : null;
    return {
      clientIdEnv: null,
      clientSecretEnv: null,
      clientId,
      clientSecret,
    };
  }

  async function createOrRotateOAuthSecret(
    input: {
      companyId: string;
      connection: typeof toolConnections.$inferSelect;
      configPath:
        "oauth.access_token" | "oauth.refresh_token" | "oauth.client_secret" | "railway.ssh_private_key";
      label: string;
      value: string;
      actor?: ActorInfo;
      existingRefs?: typeof connectionGrants.$inferSelect.credentialSecretRefs;
      ownerUserId?: string;
    },
    context?: {
      dbClient: Db | DbTransaction;
      secretClient: ReturnType<typeof secretService>;
    },
  ) {
    const existing = input.existingRefs === undefined
      ? oauthSecretRef(input.connection, input.configPath)
      : input.existingRefs.find((ref) => ref.configPath === input.configPath);
    const write = (client: Db | DbTransaction) => writeConnectionCredential(client, {
      companyId: input.companyId, connectionName: input.connection.name, configPath: input.configPath,
      label: input.label, value: input.value, existingRef: existing ?? undefined, actor: actorForSecret(input.actor),
      // Registration authenticates the OAuth client, never the person invoking tools.
      ownerUserId: input.configPath === "oauth.client_secret" ? undefined : input.ownerUserId,
      definitionKey: input.ownerUserId ? `tool_oauth.${input.connection.id}.${input.configPath.replace(/[^a-z0-9_:-]+/gi, "_")}` : undefined,
    });
    const { secret } = context ? await write(context.dbClient) : await db.transaction(write);
    return {
      secretId: secret.id, versionSelector: "latest" as const, configPath: input.configPath,
      required: input.configPath === "oauth.access_token", label: input.label,
    };
  }

  async function getOAuthGrantRow(input: {
    companyId: string;
    connectionId: string;
    grantId: string;
  }) {
    const [grant] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.id, input.grantId),
          eq(connectionGrants.companyId, input.companyId),
          eq(connectionGrants.connectionId, input.connectionId),
        ),
      )
      .limit(1);
    if (!grant) throw notFound("Connection authorization not found");
    return grant;
  }

  async function resolveOAuthGrantSecret(
    connection: typeof toolConnections.$inferSelect,
    grant: typeof connectionGrants.$inferSelect,
    ref: ToolCredentialSecretRef,
    actor: ActorInfo | undefined,
    accessContext:
      { issueId?: string | null; heartbeatRunId?: string | null } | undefined,
  ) {
    return resolveConnectionGrantSecret(db, connection, grant, ref, {
      consumerType: "tool_connection", consumerId: connection.id,
      actorType: actor?.actorType ?? "system", actorId: actor?.actorId ?? null,
      issueId: accessContext?.issueId, heartbeatRunId: accessContext?.heartbeatRunId,
    });
  }
  return { syncCredentialBindings, annotateSavedOAuthClientSecret, oauthClientForConnection, createOrRotateOAuthSecret, getOAuthGrantRow, resolveOAuthGrantSecret };
}

export type OAuthCredentialStore = ReturnType<typeof createOAuthCredentialStore>;

import { slackSearchConfigSchema } from "@paperclipai/shared";
import { SLACK_NATIVE_SEARCH_LIMITATION } from "./slack-native-search.js";
import { syncConnectionCredentialBindings } from "../connection-credential-bindings.js";
import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
  connectionGrants,
  toolConnections,
  toolOauthStates,
  type Db,
} from "@paperclipai/db";
import { z } from "zod";
import {
  badRequest,
  forbidden,
  notFound,
  unprocessable,
} from "../../errors.js";
import { secretService } from "../secrets.js";
import { toolAccessService } from "../tool-access.js";
import { logActivity } from "../activity-log.js";
import { object, slackClient } from "./slack-client.js";

export const SLACK_SEARCH_USER_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.files",
];
const configSchema = z.object({
  clientId: z.string(),
  clientSecretId: z.string().uuid(),
  revision: z.string(),
});

export function slackSearchOAuthService(
  db: Db,
  publicBaseUrl: string | undefined,
  fetchImpl = fetch,
) {
  const secrets = secretService(db);
  const vault = toolAccessService(db);
  const redirectUri = () => {
    if (!publicBaseUrl)
      throw badRequest(
        "Configure a public HTTPS URL before enabling Slack search",
      );
    const url = new URL(publicBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw badRequest("Slack search requires a public HTTPS URL");
    return new URL("/api/slack/search/callback", url.origin).toString();
  };
  async function endpoint(companyId: string, endpointId: string) {
    const [row] = await db
      .select({ endpoint: chatEndpoints, connection: toolConnections })
      .from(chatEndpoints)
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, chatEndpoints.connectionId),
          eq(toolConnections.companyId, companyId),
        ),
      )
      .where(
        and(
          eq(chatEndpoints.companyId, companyId),
          eq(chatEndpoints.id, endpointId),
          eq(chatEndpoints.provider, "slack"),
        ),
      );
    if (
      !row ||
      !["active", "verifying"].includes(row.endpoint.status) ||
      !row.connection.enabled
    )
      throw notFound("Active Slack connection not found");
    return row;
  }
  async function linked(companyId: string, endpointId: string, userId: string) {
    const row = await endpoint(companyId, endpointId);
    const [identity] = await db
      .select({ principal: chatExternalPrincipals })
      .from(chatIdentityLinks)
      .innerJoin(
        chatExternalPrincipals,
        and(
          eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
          eq(chatExternalPrincipals.companyId, companyId),
        ),
      )
      .innerJoin(
        companyMemberships,
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .where(
        and(
          eq(chatIdentityLinks.companyId, companyId),
          eq(chatIdentityLinks.endpointId, endpointId),
          eq(chatIdentityLinks.paperclipUserId, userId),
          eq(chatIdentityLinks.status, "linked"),
          eq(
            chatExternalPrincipals.providerAccountId,
            row.endpoint.providerAccountId!,
          ),
          eq(chatExternalPrincipals.isBot, false),
        ),
      );
    if (!identity)
      throw forbidden("Link your Slack identity to this connection first");
    return { ...row, slackUserId: identity.principal.externalId };
  }
  async function credential(
    companyId: string,
    connectionId: string,
    id: string,
  ) {
    return secrets.resolveSecretValue(companyId, id, "latest", {
      consumerType: "tool_connection",
      consumerId: connectionId,
      configPath: "oauth.client_secret",
      actorType: "system",
      actorId: null,
    });
  }
  async function exchange(body: Record<string, string>) {
    let response;
    try {
      response = await fetchImpl("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
    } catch {
      throw unprocessable(
        "Slack authorization did not complete. Start again from Access.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw unprocessable("Slack authorization failed");
    }
    const value = object(await response.json());
    if (value.ok !== true)
      throw unprocessable(
        "Slack rejected authorization. Check the app credentials and redirect URL.",
      );
    return value;
  }
  async function status(companyId: string, endpointId: string, userId: string) {
    const row = await endpoint(companyId, endpointId);
    const config = configSchema.safeParse(
      object(row.connection.config).slackSearch,
    );
    const [grant] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, companyId),
          eq(connectionGrants.connectionId, row.connection.id),
          eq(connectionGrants.kind, "user"),
          eq(connectionGrants.subjectUserId, userId),
          eq(connectionGrants.status, "active"),
        ),
      );
    const binding = grant?.providerTenant?.slackSearch;
    return {
      configured: config.success,
      clientId: config.success ? config.data.clientId : null,
      redirectUri: publicBaseUrl ? redirectUri() : null,
      connected: !!(
        binding &&
        binding.endpointId === endpointId &&
        config.success &&
        binding.clientRevision === config.data.revision &&
        (!grant?.providerTenant?.oauth?.accessTokenExpiresAt ||
          Date.parse(grant.providerTenant.oauth.accessTokenExpiresAt) >
            Date.now() ||
          grant.credentialSecretRefs.some(
            (ref) => ref.configPath === "oauth.refresh_token",
          ))
      ),
      nativeSearchAvailable: false,
      limitation: SLACK_NATIVE_SEARCH_LIMITATION,
    };
  }
  return {
    status,
    /** Search-only credential acquisition; no caller may use this token for writes. */
    async accessToken(companyId: string, endpointId: string, userId: string) {
      const initial = await linked(companyId, endpointId, userId);
      return db.transaction(async (tx) => {
        await tx
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.id, initial.connection.id),
              eq(toolConnections.companyId, companyId),
            ),
          )
          .for("update");
        const [connection] = await tx
          .select()
          .from(toolConnections)
          .where(eq(toolConnections.id, initial.connection.id));
        const config = configSchema.parse(
          object(connection.config).slackSearch,
        );
        const [grant] = await tx
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.companyId, companyId),
              eq(connectionGrants.connectionId, connection.id),
              eq(connectionGrants.subjectUserId, userId),
              eq(connectionGrants.kind, "user"),
              eq(connectionGrants.status, "active"),
            ),
          )
          .for("update");
        const bound = grant?.providerTenant?.slackSearch;
        if (
          !bound ||
          bound.endpointId !== endpointId ||
          bound.workspaceId !== initial.endpoint.providerAccountId ||
          bound.slackUserId !== initial.slackUserId ||
          bound.clientRevision !== config.revision
        )
          throw forbidden("Connect Slack search for the linked account first");
        await slackSearchOAuthService(
          tx as unknown as Db,
          publicBaseUrl,
          fetchImpl,
        ).assertLinked(companyId, endpointId, userId, bound.slackUserId);
        const txSecrets = secretService(tx as unknown as Db);
        const read = async (path: string) => {
          const ref = grant.credentialSecretRefs.find(
            (ref) => ref.configPath === path,
          );
          if (!ref)
            throw forbidden(
              "Slack search authorization needs to be reconnected",
            );
          return (
            await toolAccessService(
              tx as unknown as Db,
            ).resolveConnectorOAuthGrantSecret(
              connection,
              grant,
              ref,
              { actorType: "user", actorId: userId },
              undefined,
            )
          ).value;
        };
        const expiresAt = grant.providerTenant?.oauth?.accessTokenExpiresAt;
        if (!expiresAt || Date.parse(expiresAt) > Date.now() + 60_000)
          return {
            token: await read("oauth.access_token"),
            scopes: grant.providerTenant?.oauth?.scopes ?? [],
            grantId: grant.id,
          };
        const result = await exchange({
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: await txSecrets.resolveSecretValue(
            companyId,
            config.clientSecretId,
            "latest",
            {
              consumerType: "tool_connection",
              consumerId: connection.id,
              configPath: "oauth.client_secret",
              actorType: "system",
              actorId: null,
            },
          ),
          refresh_token: await read("oauth.refresh_token"),
        });
        const user =
          typeof result.access_token === "string"
            ? result
            : object(result.authed_user);
        if (
          typeof user.access_token !== "string" ||
          typeof user.expires_in !== "number" ||
          user.expires_in <= 0
        )
          throw forbidden(
            "Slack search refresh did not return an expiring user token",
          );
        const identity = await slackClient(
          user.access_token,
          fetchImpl,
        )("auth.test");
        if (
          identity.user_id !== bound.slackUserId ||
          identity.team_id !== bound.workspaceId
        )
          throw forbidden("Slack search refresh returned a different identity");
        const scopes =
          typeof user.scope === "string"
            ? user.scope.split(",")
            : (grant.providerTenant?.oauth?.scopes ?? []);
        if (
          scopes.some((scope) => !SLACK_SEARCH_USER_SCOPES.includes(scope)) ||
          !scopes.includes("search:read.public")
        )
          throw forbidden(
            "Slack search refresh returned unexpected permissions",
          );
        const refs = [...grant.credentialSecretRefs];
        for (const name of ["access_token", "refresh_token"] as const)
          if (typeof user[name] === "string") {
            const ref = await vault.storeConnectorOAuthSecret(
              {
                companyId,
                connection,
                configPath: `oauth.${name}`,
                label: `Slack search ${name}`,
                value: user[name] as string,
                existingRefs: refs,
                ownerUserId: userId,
                actor: { actorType: "user", actorId: userId },
              },
              { dbClient: tx, secretClient: txSecrets },
            );
            if (
              !refs.some((existing) => existing.configPath === ref.configPath)
            )
              refs.push(ref);
          }
        await tx
          .update(connectionGrants)
          .set({
            credentialSecretRefs: refs,
            providerTenant: {
              ...grant.providerTenant,
              oauth: {
                ...grant.providerTenant?.oauth,
                scopes,
                accessTokenExpiresAt: new Date(
                  Date.now() + user.expires_in * 1000,
                ).toISOString(),
              },
            },
            updatedAt: new Date(),
          })
          .where(eq(connectionGrants.id, grant.id));
        return { token: user.access_token, scopes, grantId: grant.id };
      });
    },
    async assertLinked(
      companyId: string,
      endpointId: string,
      userId: string,
      slackUserId: string,
    ) {
      const current = await linked(companyId, endpointId, userId);
      if (current.slackUserId !== slackUserId)
        throw forbidden("Slack linked identity changed");
    },
    async configure(
      companyId: string,
      endpointId: string,
      userId: string,
      input: unknown,
    ) {
      const values = slackSearchConfigSchema.parse(input);
      const row = await endpoint(companyId, endpointId);
      await db.transaction(async (tx) => {
        const [connection] = await tx
          .select()
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, companyId),
              eq(toolConnections.id, row.connection.id),
            ),
          )
          .for("update");
        if (!connection?.enabled)
          throw forbidden("Slack connection is no longer enabled");
        const previousConfig = configSchema.safeParse(
          object(connection.config).slackSearch,
        );
        const ref = await vault.storeConnectorOAuthSecret(
          {
            companyId,
            connection,
            configPath: "oauth.client_secret",
            label: "Slack search client secret",
            value: values.clientSecret,
            existingRefs: previousConfig.success
              ? [
                  {
                    secretId: previousConfig.data.clientSecretId,
                    configPath: "oauth.client_secret",
                    versionSelector: "latest",
                  },
                ]
              : [],
            actor: { actorType: "user", actorId: userId },
          },
          { dbClient: tx, secretClient: secretService(tx as unknown as Db) },
        );
        const config = {
          clientId: values.clientId,
          clientSecretId: ref.secretId,
          revision: randomBytes(16).toString("hex"),
        };
        const [updated] = await tx
          .update(toolConnections)
          .set({
            config: sql`${toolConnections.config} || ${JSON.stringify({ slackSearch: config })}::jsonb`,
            credentialSecretRefs: [
              ...connection.credentialSecretRefs.filter(
                (ref) => ref.configPath !== "oauth.client_secret",
              ),
              ref,
            ],
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(toolConnections.companyId, companyId),
              eq(toolConnections.id, row.connection.id),
            ),
          )
          .returning();
        await syncConnectionCredentialBindings(tx, updated);
        await logActivity(tx as unknown as Db, {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "chat.slack_search.configured",
          entityType: "chat_endpoint",
          entityId: endpointId,
        });
      });
      return status(companyId, endpointId, userId);
    },
    async start(companyId: string, endpointId: string, userId: string) {
      const row = await linked(companyId, endpointId, userId);
      const config = configSchema.parse(
        object(row.connection.config).slackSearch,
      );
      const state = `slack-search.${randomBytes(32).toString("base64url")}`;
      const redirect = redirectUri();
      await db.insert(toolOauthStates).values({
        state,
        companyId,
        connectionId: row.connection.id,
        codeVerifier: JSON.stringify({
          endpointId,
          slackUserId: row.slackUserId,
          workspaceId: row.endpoint.providerAccountId,
          clientRevision: config.revision,
          redirect,
        }),
        createdByActorType: "user",
        createdByActorId: userId,
        subjectUserId: userId,
        requestedScopes: SLACK_SEARCH_USER_SCOPES,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        user_scope: SLACK_SEARCH_USER_SCOPES.join(","),
        state,
        redirect_uri: redirect,
        team: row.endpoint.providerAccountId!,
      }).toString();
      return { url: url.toString() };
    },
    async complete(state: string, code: string, userId: string) {
      if (!state.startsWith("slack-search."))
        throw forbidden("Invalid Slack search state");
      const claimState = `slack-search-claim.${randomBytes(32).toString("base64url")}`;
      const [pending] = await db
        .update(toolOauthStates)
        .set({ state: claimState })
        .where(
          and(
            eq(toolOauthStates.state, state),
            eq(toolOauthStates.subjectUserId, userId),
            eq(toolOauthStates.createdByActorId, userId),
            gt(toolOauthStates.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!pending)
        throw forbidden(
          "Slack search authorization expired or belongs to another user",
        );
      const binding = object(JSON.parse(pending.codeVerifier));
      const row = await linked(
        pending.companyId,
        String(binding.endpointId),
        userId,
      );
      const config = configSchema.parse(
        object(row.connection.config).slackSearch,
      );
      if (
        row.connection.id !== pending.connectionId ||
        row.slackUserId !== binding.slackUserId ||
        row.endpoint.providerAccountId !== binding.workspaceId ||
        config.revision !== binding.clientRevision ||
        redirectUri() !== binding.redirect
      )
        throw forbidden("Slack search binding changed. Start again.");
      const tokens = await exchange({
        client_id: config.clientId,
        client_secret: await credential(
          pending.companyId,
          row.connection.id,
          config.clientSecretId,
        ),
        code,
        redirect_uri: redirectUri(),
      });
      const user = object(tokens.authed_user);
      if (
        object(tokens.team).id !== binding.workspaceId ||
        user.id !== binding.slackUserId ||
        typeof user.access_token !== "string"
      )
        throw forbidden(
          "Authorize the same Slack user and workspace that you linked in Paperclip",
        );
      const scopes = String(user.scope ?? "").split(",");
      if (
        scopes.some((scope) => !SLACK_SEARCH_USER_SCOPES.includes(scope)) ||
        !scopes.includes("search:read.public")
      )
        throw forbidden("Slack returned an unexpected search grant");
      const identity = await slackClient(
        user.access_token,
        fetchImpl,
      )("auth.test");
      if (
        identity.user_id !== row.slackUserId ||
        identity.team_id !== row.endpoint.providerAccountId
      )
        throw forbidden(
          "Slack token identity does not match the linked account",
        );
      return db.transaction(async (tx) => {
        // Disconnect deletes pending and in-flight states. Consume under the same
        // connection lock as configuration/refresh so a late callback cannot revive access.
        await tx
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.id, row.connection.id),
              eq(toolConnections.companyId, pending.companyId),
            ),
          )
          .for("update");
        const [liveConnection] = await tx
          .select()
          .from(toolConnections)
          .where(eq(toolConnections.id, row.connection.id));
        const liveConfig = configSchema.safeParse(
          object(liveConnection?.config).slackSearch,
        );
        if (!liveConfig.success || liveConfig.data.revision !== config.revision)
          throw forbidden(
            "Slack app configuration changed during authorization",
          );
        const [consumed] = await tx
          .delete(toolOauthStates)
          .where(
            and(
              eq(toolOauthStates.state, claimState),
              eq(toolOauthStates.subjectUserId, userId),
              gt(toolOauthStates.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!consumed)
          throw forbidden(
            "Slack search authorization was disconnected or expired",
          );
        await slackSearchOAuthService(
          tx as unknown as Db,
          publicBaseUrl,
          fetchImpl,
        ).assertLinked(
          pending.companyId,
          row.endpoint.id,
          userId,
          row.slackUserId,
        );
        const context = {
          dbClient: tx,
          secretClient: secretService(tx as unknown as Db),
        };
        const [previous] = await tx
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.companyId, pending.companyId),
              eq(connectionGrants.connectionId, row.connection.id),
              eq(connectionGrants.subjectUserId, userId),
            ),
          );
        if (previous && !previous.providerTenant?.slackSearch)
          throw forbidden(
            "This user already has a different grant on this connection",
          );
        const refs = [];
        for (const name of ["access_token", "refresh_token"] as const)
          if (typeof user[name] === "string")
            refs.push(
              await vault.storeConnectorOAuthSecret(
                {
                  companyId: pending.companyId,
                  connection: row.connection,
                  configPath: `oauth.${name}`,
                  label: `Slack search ${name}`,
                  value: user[name] as string,
                  existingRefs: previous?.credentialSecretRefs ?? [],
                  ownerUserId: userId,
                  actor: { actorType: "user", actorId: userId },
                },
                context,
              ),
            );
        const grantValues = {
          credentialSecretRefs: refs,
          status: "active" as const,
          isDefault: false,
          revokedAt: null,
          revokedByUserId: null,
          updatedAt: new Date(),
          providerTenant: {
            externalId: row.endpoint.providerAccountId!,
            slackSearch: {
              endpointId: row.endpoint.id,
              workspaceId: row.endpoint.providerAccountId!,
              slackUserId: row.slackUserId,
              clientRevision: config.revision,
            },
            oauth: {
              scopes,
              tokenType: "user",
              accessTokenExpiresAt:
                typeof user.expires_in === "number"
                  ? new Date(Date.now() + user.expires_in * 1000).toISOString()
                  : null,
            },
          },
        };
        await tx
          .insert(connectionGrants)
          .values({
            companyId: pending.companyId,
            connectionId: row.connection.id,
            kind: "user",
            subjectUserId: userId,
            createdByUserId: userId,
            ...grantValues,
          })
          .onConflictDoUpdate({
            target: [
              connectionGrants.connectionId,
              connectionGrants.subjectUserId,
            ],
            set: grantValues,
          });
        await syncConnectionCredentialBindings(tx, liveConnection);
        await logActivity(tx as unknown as Db, {
          companyId: pending.companyId,
          actorType: "user",
          actorId: userId,
          action: "chat.slack_search.connected",
          entityType: "chat_endpoint",
          entityId: row.endpoint.id,
        });
        return { endpointId: row.endpoint.id, companyId: pending.companyId };
      });
    },
    async disconnect(companyId: string, endpointId: string, userId: string) {
      const row = await endpoint(companyId, endpointId);
      await db.transaction(async (tx) => {
        await tx
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.id, row.connection.id),
              eq(toolConnections.companyId, companyId),
            ),
          )
          .for("update");
        await tx
          .update(connectionGrants)
          .set({
            status: "revoked",
            revokedAt: new Date(),
            revokedByUserId: userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(connectionGrants.companyId, companyId),
              eq(connectionGrants.connectionId, row.connection.id),
              eq(connectionGrants.kind, "user"),
              eq(connectionGrants.subjectUserId, userId),
            ),
          );
        await tx
          .delete(toolOauthStates)
          .where(
            and(
              eq(toolOauthStates.companyId, companyId),
              eq(toolOauthStates.connectionId, row.connection.id),
              eq(toolOauthStates.subjectUserId, userId),
            ),
          );
        await syncConnectionCredentialBindings(tx, row.connection);
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "chat.slack_search.disconnected",
        entityType: "chat_endpoint",
        entityId: endpointId,
      });
      return status(companyId, endpointId, userId);
    },
  };
}

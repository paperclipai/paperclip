import { connectionActorUserId } from "../actor.js";
import { actorForSecret } from "../oauth/credential-store.js";
import type { ActorInfo } from "../types.js";
import { remoteEndpoint, projectedConnectionHeaders } from "../connection-methods.js";
import { AGGREGATOR_NAMES, isAppAggregator, type AggregatorAppsResponse, type ArcadeDiscoverySetupInput } from "@paperclipai/shared/aggregator-apps";
import { resolveAggregatorApp, type AppCatalogAggregator } from "@paperclipai/shared/aggregator-app-catalog";
import { AggregatorDiscoveryUnavailableError, discoverArcadeApps, discoverExecutorApps, type DiscoveredApp } from "../../aggregator-app-discovery.js";
import { COMPOSIO_APP_TOOLKITS, findComposioCatalogApp } from "@paperclipai/shared/aggregator-app-catalog";
import type { ComposioAppAccount, ComposioAppAccountInput, ComposioAppSetupInput, ComposioAppSetupResult, ComposioAppSnapshot, ComposioAppsResponse } from "@paperclipai/shared";
import { composioAppAccounts, composioAppSetupResult } from "../../composio-app-setup.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, toolAccessAuditEvents, toolCatalogEntries, toolConnectionAppSnapshots, toolConnectionAppSyncs, toolConnections } from "@paperclipai/db";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import { initializeMcpHttpSession, getMcpHttpSession, readMcpHttpResponse, mcpHttpRequestHeaders } from "../../mcp-http.js";
import { secretService } from "../../secrets.js";
import { writeConnectionCredential } from "../../connection-credentials.js";

import type { ToolAccessAudit } from "../audit.js";
import type { ConnectionCredentialAccess } from "../credential-access.js";
import type { ToolRemoteHttp } from "../remote-http.js";
import type { ToolCatalogDiscovery } from "./discovery.js";

function aggregatorUserId(actor: ActorInfo): string {
  const userId = connectionActorUserId(actor);
  if (!userId) throw forbidden("An authorized responsible user is required");
  return userId;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type AggregatorDependencies = {
  options: { composioAppToolkits?: readonly string[] };
  secrets: ReturnType<typeof secretService>;
  audit: ToolAccessAudit;
  credentials: ConnectionCredentialAccess;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  requestRemoteHttpEndpoint: ToolRemoteHttp["requestRemoteHttpEndpoint"];
  remoteTools: ToolCatalogDiscovery["remoteTools"];
};

export function createAggregatorAccounts(db: Db, { options, secrets, audit, credentials, getConnectionRow, requestRemoteHttpEndpoint, remoteTools }: AggregatorDependencies) {
  const { vaultGrantForConnection, resolveCredentialHeaders, resolvedRemoteEndpoint } = credentials;
  const composioSyncJobs = new Map<string, Promise<void>>();

  const composioSyncTtlMs = 5 * 60_000;

  const composioSyncLeaseMs = 4 * 60_000;

  async function composioCredentialKey(connection: typeof toolConnections.$inferSelect, actor: ActorInfo) {
    const usesConnectionRefs = ["arcade", "executor"].includes(String(connection.config.sourceTemplateKey)) && connection.authKind !== "oauth" && connection.credentialPolicy === "shared";
    const grant = usesConnectionRefs ? null : await vaultGrantForConnection(connection, actor);
    const refs = grant?.credentialSecretRefs ?? connection.credentialSecretRefs;
    const discovery = asRecord(asRecord(connection.config.aggregatorDiscovery)[aggregatorUserId(actor)]);
    const ids = [...new Set([...refs.map(ref => ref.secretId), ...(typeof discovery.secretId === "string" ? [discovery.secretId] : [])])].sort();
    const versions = ids.length ? await db.select({ id: companySecrets.id, version: companySecrets.latestVersion }).from(companySecrets)
      .where(and(eq(companySecrets.companyId, connection.companyId), inArray(companySecrets.id, ids))).orderBy(asc(companySecrets.id)) : [];
    return createHash("sha256").update(JSON.stringify({ grant: grant?.id, refs, versions,
      ...(Object.keys(discovery).length ? { discovery } : {}),
      ...(connection.config.sourceTemplateKey === "arcade" || connection.config.sourceTemplateKey === "executor"
        ? { headers: projectedConnectionHeaders(connection), managementUrl: connection.config.managementUrl } : {}), endpoint: remoteEndpoint(connection.config), policy: connection.credentialPolicy, connectedAt: asRecord(connection.config.oauth)?.connectedAt })).digest("hex");
  }

  async function cachedComposioApps(connection: typeof toolConnections.$inferSelect, actor: ActorInfo): Promise<ComposioAppSnapshot[]> {
    const credentialKey = await composioCredentialKey(connection, actor);
    const rows = await db.select().from(toolConnectionAppSnapshots).where(and(
      eq(toolConnectionAppSnapshots.companyId, connection.companyId), eq(toolConnectionAppSnapshots.connectionId, connection.id),
      eq(toolConnectionAppSnapshots.userId, aggregatorUserId(actor)), eq(toolConnectionAppSnapshots.credentialKey, credentialKey),
    ));
    return rows.map(row => ({ connectionId: row.connectionId, toolkit: row.toolkit, status: row.status, accounts: row.accounts,
      checkedAt: row.checkedAt.toISOString(), errorAt: row.errorAt?.toISOString() ?? null }));
  }

  async function composioAppsResponse(connection: typeof toolConnections.$inferSelect, actor: ActorInfo): Promise<ComposioAppsResponse> {
    const credentialKey = await composioCredentialKey(connection, actor);
    const [sync] = await db.select().from(toolConnectionAppSyncs).where(and(
      eq(toolConnectionAppSyncs.companyId, connection.companyId), eq(toolConnectionAppSyncs.connectionId, connection.id),
      eq(toolConnectionAppSyncs.userId, aggregatorUserId(actor)), eq(toolConnectionAppSyncs.credentialKey, credentialKey),
    ));
    const interrupted = sync?.status === "syncing" && sync.updatedAt.getTime() < Date.now() - composioSyncLeaseMs;
    return { apps: await cachedComposioApps(connection, actor), sync: {
      status: interrupted || sync?.status === "unsupported" ? "error" : sync?.status ?? "idle", coverage: "supported_catalog",
      checked: sync?.checked ?? 0, total: sync?.total ?? 0, failed: sync?.failed ?? 0,
      lastCompletedAt: sync?.lastCompletedAt?.toISOString() ?? null,
      error: interrupted ? "App checks were interrupted. Refresh to try again."
        : (sync?.status === "error" || sync?.status === "unsupported") ? "Couldn’t finish checking Composio apps. Refresh to try again." : null,
    } };
  }

  async function openComposioGateway(connectionId: string, actor: ActorInfo) {
    const connection = await getConnectionRow(connectionId);
    await actor.managementContext?.reauthorize();
    if (!connectionActorUserId(actor)) throw forbidden("An authorized responsible user is required");
    if (connection.config.sourceTemplateKey !== "composio" || connection.transport !== "mcp_remote"
      || connection.status !== "active" || !connection.enabled) throw unprocessable("Connect your Composio gateway first");
    const catalog = await db.select().from(toolCatalogEntries).where(and(
      eq(toolCatalogEntries.companyId, connection.companyId), eq(toolCatalogEntries.connectionId, connection.id),
    ));
    if (!catalog.some(tool => tool.toolName === "COMPOSIO_MANAGE_CONNECTIONS" && tool.status === "active")) {
      throw unprocessable("Refresh your Composio gateway's actions before configuring this app");
    }
    const endpoint = await resolvedRemoteEndpoint(connection, actor);
    const headers = { ...projectedConnectionHeaders(connection), ...(await resolveCredentialHeaders(connection, actor)) };
    const credentialKey = await composioCredentialKey(await getConnectionRow(connectionId), actor);
    const send = (init: RequestInit) => requestRemoteHttpEndpoint(new URL(endpoint), { ...init, signal: AbortSignal.timeout(30_000) });
    let sessionHeaders = connection.config.mcpSessionRequired === true
      ? await getMcpHttpSession({ send, headers, scope: `${connection.id}:app-setup:${actor.actorId}`, requestId: "paperclip-app-setup" }) : headers;
    async function manage(toolkits: { name: string; action: "list" | "add" | "rename" | "remove"; account_id?: string; alias?: string }[], tolerateToolkitErrors = false) {
      const checkedAt = new Date();
      const id = `paperclip-app-setup-${randomUUID()}`;
      const request = () => send({ method: "POST", headers: mcpHttpRequestHeaders(sessionHeaders), body: JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call", params: { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits } },
      }) });
      const markFailed = async () => {
        const names = toolkits.filter(tool => tool.action === "list").map(tool => tool.name);
        if (names.length) await db.update(toolConnectionAppSnapshots).set({ errorAt: checkedAt }).where(and(
          eq(toolConnectionAppSnapshots.companyId, connection.companyId), eq(toolConnectionAppSnapshots.connectionId, connectionId),
          eq(toolConnectionAppSnapshots.userId, aggregatorUserId(actor)), eq(toolConnectionAppSnapshots.credentialKey, credentialKey),
          inArray(toolConnectionAppSnapshots.toolkit, names), lte(toolConnectionAppSnapshots.checkedAt, checkedAt),
        ));
      };
      try {
      let response = await request();
      // Only reads retry. An uncertain account mutation must never repeat automatically.
      if (toolkits.every(tool => tool.action === "list") && (response.status === 400 || response.status === 404)) {
        await response.body?.cancel();
        sessionHeaders = await initializeMcpHttpSession({ send, headers, requestId: id });
        response = await request();
      }
      if (!response.ok) throw new HttpError(502, toolkits.every(tool => tool.action === "list")
        ? "Composio could not check this app. Reconnect the gateway if its sign-in expired."
        : "Composio has not confirmed this change. Refresh the accounts before trying again.", { code: "composio_app_setup_failed", status: response.status });
      const payload = await readMcpHttpResponse(response, id);
      if (await composioCredentialKey(await getConnectionRow(connectionId), actor) !== credentialKey) {
        throw conflict("The Composio account changed while checking apps. Refresh to check the current account.");
      }
      const failedToolkits: string[] = [];
      for (const tool of toolkits.filter(tool => tool.action === "list")) {
        let accounts: ComposioAppAccount[];
        try {
          composioAppSetupResult(payload, tool.name);
          const parsed = composioAppAccounts(payload, tool.name);
          if (!parsed) throw unprocessable("Composio did not return a complete account list. Refresh the accounts before trying again.");
          accounts = parsed;
        } catch (error) {
          await db.update(toolConnectionAppSnapshots).set({ errorAt: checkedAt }).where(and(
            eq(toolConnectionAppSnapshots.companyId, connection.companyId), eq(toolConnectionAppSnapshots.connectionId, connectionId),
            eq(toolConnectionAppSnapshots.userId, aggregatorUserId(actor)), eq(toolConnectionAppSnapshots.credentialKey, credentialKey),
            eq(toolConnectionAppSnapshots.toolkit, tool.name), lte(toolConnectionAppSnapshots.checkedAt, checkedAt),
          ));
          if (!tolerateToolkitErrors) throw error;
          failedToolkits.push(tool.name);
          continue;
        }
        const status = accounts.some(account => account.status === "ACTIVE") ? "connected" as const : "not_connected" as const;
        await db.insert(toolConnectionAppSnapshots).values({ companyId: connection.companyId, connectionId, userId: aggregatorUserId(actor),
          credentialKey, toolkit: tool.name, accounts, status, checkedAt, errorAt: null,
        }).onConflictDoUpdate({ target: [toolConnectionAppSnapshots.companyId, toolConnectionAppSnapshots.connectionId, toolConnectionAppSnapshots.userId, toolConnectionAppSnapshots.toolkit],
          set: { accounts, status, checkedAt, credentialKey, errorAt: null }, setWhere: lte(toolConnectionAppSnapshots.checkedAt, checkedAt) });
      }
      return { payload, failedToolkits };
      } catch (error) { await markFailed(); throw error; }
    }
    return { connection, catalog, credentialKey, manage: async (...args: Parameters<typeof manage>) => (await manage(...args)).payload, checkBatch: manage };
  }

  async function startComposioAppSync(connectionId: string, force: boolean, actor: ActorInfo) {
    const opened = await openComposioGateway(connectionId, actor);
    const { connection, credentialKey } = opened;
    const existing = await cachedComposioApps(connection, actor);
    const catalog = options.composioAppToolkits ?? COMPOSIO_APP_TOOLKITS;
    const toolkits = [...new Set([...existing.filter(app => app.accounts.length > 0).map(app => app.toolkit), ...catalog])];
    const leaseId = randomUUID();
    const startedAt = new Date();
    const [lease] = await db.insert(toolConnectionAppSyncs).values({ companyId: connection.companyId, connectionId,
      userId: aggregatorUserId(actor), credentialKey, leaseId, status: "syncing", total: toolkits.length, updatedAt: startedAt,
    }).onConflictDoUpdate({ target: [toolConnectionAppSyncs.companyId, toolConnectionAppSyncs.connectionId, toolConnectionAppSyncs.userId, toolConnectionAppSyncs.credentialKey],
      set: { leaseId, status: "syncing", checked: 0, total: toolkits.length, failed: 0, updatedAt: startedAt },
      setWhere: and(
        or(ne(toolConnectionAppSyncs.status, "syncing"), lt(toolConnectionAppSyncs.updatedAt, new Date(Date.now() - composioSyncLeaseMs))),
        force ? sql`true` : or(ne(toolConnectionAppSyncs.status, "ready"), isNull(toolConnectionAppSyncs.lastCompletedAt),
          lt(toolConnectionAppSyncs.lastCompletedAt, new Date(Date.now() - composioSyncTtlMs))),
      ),
    }).returning();
    if (lease) {
      const updateLease = async (values: Partial<typeof toolConnectionAppSyncs.$inferInsert>) => {
        const updated = await db.update(toolConnectionAppSyncs).set({ ...values, updatedAt: new Date() })
          .where(and(eq(toolConnectionAppSyncs.id, lease.id), eq(toolConnectionAppSyncs.leaseId, leaseId))).returning({ id: toolConnectionAppSyncs.id });
        if (!updated.length) throw conflict("App checks were replaced by a newer sync.");
      };
      const job = (async () => {
        let failed = 0;
        try {
          for (let start = 0; start < toolkits.length; start += 32) {
            if (Date.now() - startedAt.getTime() > composioSyncLeaseMs) throw new Error("Sync deadline exceeded");
            await updateLease({});
            const current = start === 0 ? opened : await openComposioGateway(connectionId, actor);
            if (current.credentialKey !== credentialKey) throw conflict("Composio credentials changed during sync.");
            const batch = toolkits.slice(start, start + 32);
            const result = await current.checkBatch(batch.map(name => ({ name, action: "list" })), true);
            failed += result.failedToolkits.length;
            await updateLease({ checked: start + batch.length, failed });
          }
          await updateLease({ status: failed > 0 ? "error" : "ready", lastCompletedAt: new Date(), failed });
        } catch {
          const [activeLease] = await db.select({ id: toolConnectionAppSyncs.id }).from(toolConnectionAppSyncs)
            .where(and(eq(toolConnectionAppSyncs.id, lease.id), eq(toolConnectionAppSyncs.leaseId, leaseId)));
          if (!activeLease) return;
          // Preserve observations, but never present a failed check as current authorization.
          await db.update(toolConnectionAppSnapshots).set({ errorAt: new Date() }).where(and(
            eq(toolConnectionAppSnapshots.companyId, connection.companyId), eq(toolConnectionAppSnapshots.connectionId, connectionId),
            eq(toolConnectionAppSnapshots.userId, aggregatorUserId(actor)), eq(toolConnectionAppSnapshots.credentialKey, credentialKey),
            lte(toolConnectionAppSnapshots.checkedAt, startedAt),
          ));
          await updateLease({ status: "error", failed }).catch(() => undefined);
        }
      })();
      composioSyncJobs.set(leaseId, job);
      void job.finally(() => composioSyncJobs.delete(leaseId)).catch(() => undefined);
    }
    return composioAppsResponse(await getConnectionRow(connectionId), actor);
  }

  function aggregatorProvider(connection: typeof toolConnections.$inferSelect): AppCatalogAggregator {
    const provider = connection.config.sourceTemplateKey;
    if (!isAppAggregator(provider) || connection.transport !== "mcp_remote") throw notFound("Aggregator gateway not found");
    return provider;
  }

  async function assertDiscoveryActor(actor: ActorInfo) {
    await actor.managementContext?.reauthorize();
    if (!connectionActorUserId(actor)) throw forbidden("An authorized responsible user is required");
  }

  async function aggregatorDiscoveryState(connection: typeof toolConnections.$inferSelect, actor: ActorInfo, retryUnsupported = false): Promise<AggregatorAppsResponse["discovery"]> {
    const provider = aggregatorProvider(connection);
    if (connection.status !== "active" || !connection.enabled) return { availability: "disabled", message: "Restore this gateway to check its accounts." };
    if (provider === "arcade") {
      const discovery = asRecord(asRecord(connection.config.aggregatorDiscovery)[aggregatorUserId(actor)]);
      const headers = projectedConnectionHeaders(connection);
      const grant = connection.authKind === "oauth" || connection.credentialPolicy !== "shared" ? await vaultGrantForConnection(connection, actor) : null;
      const refs = grant?.credentialSecretRefs ?? connection.credentialSecretRefs;
      const hasUserId = Boolean(Object.entries(headers).find(([key]) => key.toLowerCase() === "arcade-user-id")?.[1])
        || refs.some(ref => ref.configPath.toLowerCase() === "headers.arcade-user-id");
      if ((!discovery.secretId || !discovery.userId) && !(hasUserId && connection.authKind === "api_key")) {
        return { availability: "setup_required", message: "Set up account sync to see your Arcade apps here." };
      }
    }
    const catalog = await db.select({ name: toolCatalogEntries.toolName }).from(toolCatalogEntries).where(and(
      eq(toolCatalogEntries.companyId, connection.companyId), eq(toolCatalogEntries.connectionId, connection.id), eq(toolCatalogEntries.status, "active"),
    ));
    if ((provider === "executor" && !catalog.some(tool => ["integrations", "execute"].includes(tool.name)))
      || (provider === "composio" && !catalog.some(tool => tool.name === "COMPOSIO_MANAGE_CONNECTIONS"))) {
      return { availability: "unsupported", message: `${AGGREGATOR_NAMES[provider]} account discovery is unavailable on this gateway. Refresh its actions or check its setup.` };
    }
    if (!retryUnsupported && provider === "executor") {
      const credentialKey = await composioCredentialKey(connection, actor);
      const [sync] = await db.select({ status: toolConnectionAppSyncs.status }).from(toolConnectionAppSyncs).where(and(
        eq(toolConnectionAppSyncs.companyId, connection.companyId), eq(toolConnectionAppSyncs.connectionId, connection.id),
        eq(toolConnectionAppSyncs.userId, aggregatorUserId(actor)), eq(toolConnectionAppSyncs.credentialKey, credentialKey),
      ));
      if (sync?.status === "unsupported") return { availability: "unsupported", message: "Executor account discovery is unavailable on this server. You can still use the gateway’s actions." };
    }
    return { availability: "available", message: null };
  }

  async function aggregatorAppsResponse(connection: typeof toolConnections.$inferSelect, actor: ActorInfo): Promise<AggregatorAppsResponse> {
    await assertDiscoveryActor(actor);
    const provider = aggregatorProvider(connection);
    const result = await composioAppsResponse(connection, actor);
    const discovery = await aggregatorDiscoveryState(connection, actor);
    return { provider, discovery, apps: result.apps.map(snapshot => {
      const app = resolveAggregatorApp(provider, snapshot.toolkit, snapshot.accounts[0]?.appName);
      return { ...snapshot, provider, freshness: discovery.availability !== "available" || snapshot.errorAt || result.sync.status === "error" || connection.status !== "active" || !connection.enabled || Date.now() - new Date(snapshot.checkedAt).getTime() > composioSyncTtlMs ? "stale" as const : "fresh" as const, appSlug: app.slug.startsWith(`${provider}:`) ? `${provider}:${connection.id}:${snapshot.toolkit}` : snapshot.accounts[0]?.appSlug ?? app.slug, appName: snapshot.accounts[0]?.appName ?? app.name };
    }), sync: { ...result.sync, coverage: provider === "composio" ? "supported_catalog" : provider === "arcade" ? "gateway_tools" : "visible_accounts",
      error: result.sync.error ? `Couldn’t finish checking ${AGGREGATOR_NAMES[provider]} apps. Refresh to try again.` : null,
    } };
  }

  async function discoverAggregatorInventory(connection: typeof toolConnections.$inferSelect, actor: ActorInfo): Promise<DiscoveredApp[]> {
    const provider = aggregatorProvider(connection);
    const tools = await remoteTools(connection, undefined, actor);
    connection = await getConnectionRow(connection.id);
    const headers = { ...projectedConnectionHeaders(connection), ...(await resolveCredentialHeaders(connection, actor)) };
    const endpoint = new URL(await resolvedRemoteEndpoint(connection, actor));
    if (provider === "arcade") {
      // The extra project credential never joins invocation headers or tool grants.
      if (endpoint.hostname !== "api.arcade.dev" || endpoint.protocol !== "https:") throw unprocessable("Account sync requires an Arcade Cloud gateway");
      const discovery = asRecord(asRecord(connection.config.aggregatorDiscovery)[aggregatorUserId(actor)]);
      let key: string | undefined;
      let userId: string | undefined;
      if (typeof discovery.secretId === "string" && typeof discovery.userId === "string") {
        const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.id, discovery.secretId), eq(companySecrets.companyId, connection.companyId), eq(companySecrets.ownerUserId, aggregatorUserId(actor))));
        if (!secret?.userSecretDefinitionId) throw forbidden("Your Arcade discovery credential is unavailable");
        const resolved = await secrets.resolveUserSecretValue(connection.companyId, { definitionId: secret.userSecretDefinitionId, responsibleUserId: aggregatorUserId(actor), required: true }, {
          actorType: actor.actorType === "agent" ? "agent" : "user", actorId: actor.actorId!, heartbeatRunId: actor.managementContext?.workContext.runId, consumerType: "tool_connection", consumerId: connection.id, responsibleUserId: aggregatorUserId(actor),
        });
        key = resolved?.value;
        userId = discovery.userId;
      } else {
        userId = Object.entries(headers).find(([name]) => name.toLowerCase() === "arcade-user-id")?.[1];
        if (connection.authKind === "api_key") key = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1].replace(/^Bearer\s+/i, "");
      }
      if (!key || !userId) throw unprocessable("Set up Arcade account sync first");
      return discoverArcadeApps({ userId, gatewayTools: tools.map(tool => tool.name), request: async path => {
        const response = await requestRemoteHttpEndpoint(new URL(path, endpoint.origin), { method: "GET", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, "Arcade could not list your accounts. Check the project API key and Arcade user ID."); }
        return response.json();
      } });
    }
    const send = (init: RequestInit) => requestRemoteHttpEndpoint(endpoint, { ...init, signal: AbortSignal.timeout(30_000) });
    let sessionHeaders = connection.config.mcpSessionRequired === true ? await getMcpHttpSession({ send, headers, scope: `${connection.id}:inventory:${actor.actorId}`, requestId: "paperclip-account-inventory" }) : headers;
    return discoverExecutorApps({ toolNames: tools.map(tool => tool.name), managementUrl: typeof connection.config.managementUrl === "string" ? connection.config.managementUrl : null,
      call: async (name, args) => {
        const id = `paperclip-account-inventory-${randomUUID()}`;
        const request = () => send({ method: "POST", headers: mcpHttpRequestHeaders(sessionHeaders), body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
        let response = await request();
        if (response.status === 400 || response.status === 404) {
          await response.body?.cancel(); sessionHeaders = await initializeMcpHttpSession({ send, headers, requestId: id }); response = await request();
        }
        if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, "Executor could not list your accounts. Reconnect if sign-in expired."); }
        return readMcpHttpResponse(response, id);
      },
    });
  }

  async function syncAggregatorApps(connectionId: string, force: boolean, actor: ActorInfo): Promise<AggregatorAppsResponse> {
    await assertDiscoveryActor(actor);
    let connection = await getConnectionRow(connectionId);
    const provider = aggregatorProvider(connection);
    const discovery = await aggregatorDiscoveryState(connection, actor, force);
    if (discovery.availability !== "available") return aggregatorAppsResponse(connection, actor);
    if (provider === "composio") {
      await startComposioAppSync(connectionId, force, actor);
      return aggregatorAppsResponse(await getConnectionRow(connectionId), actor);
    }
    // Resolve/refresh the caller's gateway credentials before fingerprinting the lease.
    await resolveCredentialHeaders(connection, actor);
    connection = await getConnectionRow(connectionId);
    const credentialKey = await composioCredentialKey(connection, actor);
    const leaseId = randomUUID();
    const startedAt = new Date();
    const [lease] = await db.insert(toolConnectionAppSyncs).values({ companyId: connection.companyId, connectionId, userId: aggregatorUserId(actor), credentialKey, leaseId, status: "syncing", updatedAt: startedAt })
      .onConflictDoUpdate({ target: [toolConnectionAppSyncs.companyId, toolConnectionAppSyncs.connectionId, toolConnectionAppSyncs.userId, toolConnectionAppSyncs.credentialKey],
        set: { leaseId, status: "syncing", checked: 0, total: 0, failed: 0, updatedAt: startedAt },
        setWhere: and(or(ne(toolConnectionAppSyncs.status, "syncing"), lt(toolConnectionAppSyncs.updatedAt, new Date(Date.now() - composioSyncLeaseMs))),
          force ? sql`true` : or(ne(toolConnectionAppSyncs.status, "ready"), isNull(toolConnectionAppSyncs.lastCompletedAt), lt(toolConnectionAppSyncs.lastCompletedAt, new Date(Date.now() - composioSyncTtlMs)))),
      }).returning();
    if (lease) {
      const job = (async () => {
        try {
          const apps = await discoverAggregatorInventory(connection, actor);
          await db.transaction(async tx => {
            const [current] = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, connection.companyId))).for("update");
            const [active] = await tx.select().from(toolConnectionAppSyncs).where(and(eq(toolConnectionAppSyncs.id, lease.id), eq(toolConnectionAppSyncs.leaseId, leaseId))).for("update");
            if (!current || !active || current.status !== "active" || !current.enabled || Date.now() - startedAt.getTime() > composioSyncLeaseMs
              || await composioCredentialKey(current, actor) !== credentialKey) throw conflict("The gateway changed during account discovery");
            const checkedAt = new Date();
            // Commit the entire enumeration at once; a failed later page cannot delete accounts.
            await tx.update(toolConnectionAppSnapshots).set({ accounts: [], status: "not_connected", checkedAt, errorAt: null }).where(and(
              eq(toolConnectionAppSnapshots.companyId, connection.companyId), eq(toolConnectionAppSnapshots.connectionId, connectionId), eq(toolConnectionAppSnapshots.userId, aggregatorUserId(actor)), eq(toolConnectionAppSnapshots.credentialKey, credentialKey),
            ));
            for (const app of apps) await tx.insert(toolConnectionAppSnapshots).values({ companyId: connection.companyId, connectionId, userId: aggregatorUserId(actor), credentialKey,
              toolkit: app.toolkit, accounts: app.accounts, status: app.accounts.some(account => account.status === "ACTIVE") ? "connected" : "not_connected", checkedAt,
            }).onConflictDoUpdate({ target: [toolConnectionAppSnapshots.companyId, toolConnectionAppSnapshots.connectionId, toolConnectionAppSnapshots.userId, toolConnectionAppSnapshots.toolkit],
              set: { accounts: app.accounts, status: app.accounts.some(account => account.status === "ACTIVE") ? "connected" : "not_connected", checkedAt, errorAt: null, credentialKey },
            });
            await tx.update(toolConnectionAppSyncs).set({ status: "ready", checked: apps.length, total: apps.length, failed: 0, updatedAt: checkedAt, lastCompletedAt: checkedAt }).where(eq(toolConnectionAppSyncs.id, lease.id));
          });
        } catch (error) {
          await db.transaction(async tx => {
            const [active] = await tx.select().from(toolConnectionAppSyncs).where(and(eq(toolConnectionAppSyncs.id, lease.id), eq(toolConnectionAppSyncs.leaseId, leaseId))).for("update");
            if (!active) return;
            await tx.update(toolConnectionAppSnapshots).set({ errorAt: new Date() }).where(and(eq(toolConnectionAppSnapshots.companyId, connection.companyId), eq(toolConnectionAppSnapshots.connectionId, connectionId), eq(toolConnectionAppSnapshots.userId, aggregatorUserId(actor)), eq(toolConnectionAppSnapshots.credentialKey, credentialKey)));
            await tx.update(toolConnectionAppSyncs).set({ status: error instanceof AggregatorDiscoveryUnavailableError ? "unsupported" : "error", failed: 1, updatedAt: new Date() }).where(eq(toolConnectionAppSyncs.id, lease.id));
          });
        }
      })();
      composioSyncJobs.set(leaseId, job);
      void job.finally(() => composioSyncJobs.delete(leaseId)).catch(() => undefined);
    }
    return aggregatorAppsResponse(await getConnectionRow(connectionId), actor);
  }

  async function configureArcadeDiscovery(connectionId: string, input: ArcadeDiscoverySetupInput, actor: ActorInfo) {
    await actor?.managementContext?.reauthorize();
    await assertDiscoveryActor(actor);
    const companyId = (await getConnectionRow(connectionId)).companyId;
    await db.transaction(async tx => {
      const [connection] = await tx.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).for("update");
      if (!connection || aggregatorProvider(connection) !== "arcade" || connection.status === "archived") throw notFound("Arcade gateway not found");
      const all = asRecord(connection.config.aggregatorDiscovery);
      const before = asRecord(all[aggregatorUserId(actor)]);
      const { secret } = await writeConnectionCredential(tx, {
        companyId: connection.companyId, connectionName: connection.name, configPath: "aggregatorDiscovery.apiKey", label: "Arcade account sync API key",
        value: input.apiKey, ownerUserId: aggregatorUserId(actor), actor: actorForSecret(actor),
        existingRef: typeof before.secretId === "string" ? { secretId: before.secretId, configPath: "aggregatorDiscovery.apiKey", versionSelector: "latest" } : undefined,
        definitionKey: `arcade_discovery.${connection.id}`,
      });
      const config = { ...connection.config, aggregatorDiscovery: { ...all, [aggregatorUserId(actor)]: { userId: input.userId, secretId: secret.id } } };
      await tx.update(toolConnections).set({ config, transportConfig: config, updatedAt: new Date() }).where(eq(toolConnections.id, connectionId));
    });
    await logActivity(db, { companyId, ...(actor.managementContext?.audit ?? { actorType: "user" as const, actorId: actor.actorId! }), action: "tool_connection.account_sync_configured", entityType: "tool_connection", entityId: connectionId, details: { provider: "arcade" } });
    return syncAggregatorApps(connectionId, true, actor);
  }
  return {
    syncAggregatorApps, configureArcadeDiscovery,
    async setupComposioApp(connectionId: string, toolkit: string, input: ComposioAppSetupInput, actor: ActorInfo): Promise<ComposioAppSetupResult> {
      if (!findComposioCatalogApp(toolkit)) throw notFound("This Composio app is not in the catalog");
      const { connection, manage } = await openComposioGateway(connectionId, actor);
      let result = composioAppSetupResult(await manage([{ name: toolkit, action: "list" }]), toolkit);
      if (input.action === "start" && result.status !== "connected") {
        result = composioAppSetupResult(await manage([{ name: toolkit, action: "add" }]), toolkit);
        if (result.status === "not_connected") throw unprocessable("Composio did not return a sign-in link for this app. Manage it in Composio to check its setup requirements.");
      }
      if (input.action === "complete") {
        if (result.status !== "connected") throw conflict("Finish connecting this app in Composio, then check again");
        const currentConnection = await getConnectionRow(connectionId);
        if (currentConnection.status !== "active" || !currentConnection.enabled) {
          throw conflict("The gateway is no longer active. Restore it before connecting this app.");
        }
      }
      await audit({ companyId: connection.companyId, connectionId, action: "tool_connection.upstream_app_setup", outcome: "success", actor,
        details: { toolkit, action: input.action, status: result.status } });
      return result;
    },
    listAggregatorApps: async (connectionId: string, actor: ActorInfo) => aggregatorAppsResponse(await getConnectionRow(connectionId), actor),
    refreshAggregatorApps: async (connectionId: string, requested: string[], actor: ActorInfo) => {
    await actor?.managementContext?.reauthorize();
      const connection = await getConnectionRow(connectionId);
      if (aggregatorProvider(connection) === "composio" && requested.length) {
        const { manage } = await openComposioGateway(connectionId, actor);
        if (requested.some(toolkit => !findComposioCatalogApp(toolkit))) throw notFound("This Composio app is not in the catalog");
        await manage(requested.map(name => ({ name, action: "list" })));
        return aggregatorAppsResponse(connection, actor);
      }
      return syncAggregatorApps(connectionId, true, actor);
    },
    syncComposioApps: startComposioAppSync,
    async listComposioApps(connectionId: string, actor: ActorInfo) {
      const connection = await getConnectionRow(connectionId);
      await actor.managementContext?.reauthorize();
      if (!connectionActorUserId(actor)) throw forbidden("An authorized responsible user is required");
      if (connection.config.sourceTemplateKey !== "composio") throw notFound("Composio gateway not found");
      return composioAppsResponse(connection, actor);
    },
    async refreshComposioApps(connectionId: string, requested: string[], actor: ActorInfo) {
      await actor.managementContext?.reauthorize();
      if (requested.some(toolkit => !findComposioCatalogApp(toolkit))) throw notFound("This Composio app is not in the catalog");
      const { connection, manage } = await openComposioGateway(connectionId, actor);
      const existing = await cachedComposioApps(connection, actor);
      // Migrate observations from the original direct setup flow on the first visit.
      const history = await db.select({ details: toolAccessAuditEvents.details }).from(toolAccessAuditEvents).where(and(
        eq(toolAccessAuditEvents.companyId, connection.companyId), eq(toolAccessAuditEvents.connectionId, connectionId),
        eq(toolAccessAuditEvents.actorId, actor.actorId!), eq(toolAccessAuditEvents.action, "tool_connection.upstream_app_setup"),
      )).orderBy(desc(toolAccessAuditEvents.createdAt)).limit(128);
      const known = [...existing.filter(app => app.accounts.length > 0).map(app => app.toolkit),
        ...history.map(row => row.details.toolkit).filter((toolkit): toolkit is string => typeof toolkit === "string" && Boolean(findComposioCatalogApp(toolkit)))];
      const toolkits = [...new Set([...requested, ...known])];
      for (let start = 0; start < toolkits.length; start += 32) {
        await manage(toolkits.slice(start, start + 32).map(name => ({ name, action: "list" })));
      }
      return composioAppsResponse(connection, actor);
    },
    async manageComposioAppAccount(connectionId: string, toolkit: string, input: ComposioAppAccountInput, actor: ActorInfo) {
      if (!findComposioCatalogApp(toolkit)) throw notFound("This Composio app is not in the catalog");
      const { connection, manage } = await openComposioGateway(connectionId, actor);
      if (input.action !== "add") {
        const before = composioAppAccounts(await manage([{ name: toolkit, action: "list" }]), toolkit);
        if (!before?.some(account => account.id === input.accountId)) throw notFound("This account is no longer available in the selected Composio app");
      }
      const details = { toolkit, ...(input.action !== "add" ? { accountId: input.accountId } : {}) };
      await logActivity(db, { companyId: connection.companyId, ...(actor.managementContext?.audit ?? { actorType: "user" as const, actorId: actor.actorId! }),
        action: `tool_connection.upstream_account_${input.action}_requested`, entityType: "tool_connection", entityId: connectionId, details });
      let payload: unknown;
      try {
        payload = await manage([{ name: toolkit, action: input.action,
          ...(input.action !== "add" ? { account_id: input.accountId } : {}), ...(input.action === "rename" ? { alias: input.alias } : {}) }]);
      } catch (error) {
        await audit({ companyId: connection.companyId, connectionId, actor, action: `tool_connection.upstream_account_${input.action}`,
          outcome: "failure", reasonCode: "provider_unconfirmed", details });
        throw error;
      }
      const result = composioAppSetupResult(payload, toolkit); // Reject provider errors before reporting success.
      if (input.action === "add" && !result.authorizationUrl) throw unprocessable("Composio did not return a sign-in link. Check the app in Composio.");
      if (input.action !== "add") {
        const after = composioAppAccounts(await manage([{ name: toolkit, action: "list" }]), toolkit);
        if (!after || (input.action === "remove" ? after.some(account => account.id === input.accountId)
          : !after.some(account => account.id === input.accountId && account.alias === input.alias))) {
          throw conflict("Composio has not confirmed this change. Refresh the accounts before trying again.");
        }
      }
      await logActivity(db, { companyId: connection.companyId, ...(actor.managementContext?.audit ?? { actorType: "user" as const, actorId: actor.actorId! }),
        action: `tool_connection.upstream_account_${input.action}`, entityType: "tool_connection", entityId: connectionId,
        details: { toolkit, ...(input.action !== "add" ? { accountId: input.accountId } : {}) } });
      return { ...result, apps: await cachedComposioApps(connection, actor) };
    }
  };
}

import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { authorizeExternalBotOperator, externalBotEnabled } from "../external-bot-authority.js";
import { updateAgentConfigurationInTransaction } from "../agent-configuration-transaction.js";
import { instanceSettingsService } from "../instance-settings.js";
import { createHash, randomBytes } from "node:crypto";
import { canConfigureAgentConnection } from "../../modules/agent-lifecycle/index.js";
import { and, eq, gt, inArray, isNull, lt, lte, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { Request } from "express";
import {
  type Db, activityLog, agents, authUsers, companies, companyLogos, dotAgentBindings, museAgentBindings, mcpOauthClients, mcpOauthGrants, mcpOauthRequests, mcpOauthTokens, mcpOauthDeviceRequests, mcpOauthMetadataAdmissions,
} from "@paperclipai/db";
import { DOT_RUNNER_MCP_PATH, DOT_RUNNER_MCP_SCOPES, PUBLIC_MCP_PATH, PUBLIC_MCP_SCOPES, MUSE_RESOURCE_PATH, MUSE_OAUTH_PATH, MUSE_OAUTH_SCOPES, type McpConnectionRequest, type McpDotPairingPreview } from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { withExternalAdmissionGuard } from "../../modules/external-agents/index.js";
import { assertMuseCurrentAuthority, revokeMuseOAuthGrant } from "../muse-identity.js";
import { boardAuthService } from "../board-auth.js";
import { logActivity } from "../activity-log.js";
import { createClientMetadataResolver, mcpRedirectMatches, validMcpRedirect as validRedirect, type MetadataFetch } from "./client-metadata.js";
import { beginMuseCodeExchange, decideMuseCodeExchange, observeMuseCodeBinding, publishMuseCodeActivities, recordMuseCodeRejection, recordMuseCodeSuccess, type MuseCodeExchangeCheck, type MuseCodeExchangeObservation } from "./muse-oauth-diagnostics.js";

const minute = 60_000;
const accessLifetime = 15 * minute;
const refreshLifetime = 30 * 24 * 60 * minute;
export const hashMcpSecret = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (prefix: string) => prefix + randomBytes(32).toString("base64url");

export class McpOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export class PublicMcpDisabledError extends McpOAuthError {
  constructor() { super("temporarily_unavailable", "Assistant connections are disabled. Enable them in Settings > Experimental.", 503); }
}
const invalidGrant = () => new McpOAuthError("invalid_grant", "Authorization is expired, revoked, or invalid.");

export function publicMcpConfig(env: NodeJS.ProcessEnv = process.env, authPublicBaseUrl?: string) {
  const origin = env.PAPERCLIP_PUBLIC_URL ?? authPublicBaseUrl;
  if (!origin) return null;
  const normalizeOrigin = (value: string, setting: string) => {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`Public MCP requires ${setting} to be an HTTPS origin (HTTP loopback is allowed for development).`);
    }
    return url.origin;
  };
  const publicOrigin = normalizeOrigin(origin, "PAPERCLIP_PUBLIC_URL");
  // Optional browser ingress for the same instance. Protocol issuer, resource,
  // token exchange and callback delivery remain on the public MCP origin.
  const authorizationOrigin = env.PAPERCLIP_MCP_AUTHORIZATION_ORIGIN
    ? normalizeOrigin(env.PAPERCLIP_MCP_AUTHORIZATION_ORIGIN, "PAPERCLIP_MCP_AUTHORIZATION_ORIGIN") : undefined;
  return { origin: publicOrigin, resource: publicOrigin + PUBLIC_MCP_PATH, ...(authorizationOrigin ? { authorizationOrigin } : {}) };
}
export type PublicMcpConfig = NonNullable<ReturnType<typeof publicMcpConfig>>;
export type McpPrincipal = {
  grant: typeof mcpOauthGrants.$inferSelect;
  actor: Request["actor"];
  company: { id: string; name: string; issuePrefix: string; status: string };
};

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(z.string().max(2048).refine(validRedirect)).max(10).default([]),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token", DEVICE_GRANT])).default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.literal("code")).default(["code"]),
}).strip();

const authorizeSchema = z.object({
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().max(2048),
  response_type: z.literal("code"),
  resource: z.string().max(2048),
  scope: z.string().max(200).default("paperclip:read"),
  state: z.string().max(2048).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  company_id: z.string().uuid().optional(),
}).strip();

export type McpOAuthMode = "personal" | "openai_dot_agent" | "muse_agent";
export function createPublicMcpOAuth(db: Db, config: PublicMcpConfig, options: { metadataFetch?: MetadataFetch; mode?: McpOAuthMode } = {}) {
  const mode = options.mode ?? (new URL(config.resource).pathname === DOT_RUNNER_MCP_PATH ? "openai_dot_agent" : "personal");
  const museAgentConnection = mode === "muse_agent", dotAgentConnection = mode === "openai_dot_agent";
  const agentConnection = museAgentConnection || dotAgentConnection;
  if (museAgentConnection && config.resource !== config.origin + MUSE_RESOURCE_PATH) throw new McpOAuthError("invalid_target", "Muse has one fixed agent resource.");
  const scopesSupported = museAgentConnection ? MUSE_OAUTH_SCOPES : dotAgentConnection ? DOT_RUNNER_MCP_SCOPES : PUBLIC_MCP_SCOPES;
  const requiredScope = agentConnection ? "paperclip:agent" : "paperclip:read";
  const defaultScope = museAgentConnection ? MUSE_OAUTH_SCOPES.join(" ") : requiredScope;
  const issuer = museAgentConnection ? config.origin + MUSE_OAUTH_PATH : dotAgentConnection ? config.origin + DOT_RUNNER_MCP_PATH + "/oauth" : config.origin;
  function withResource(input: unknown) {
    return museAgentConnection && input && typeof input === "object" && !Array.isArray(input) && !("resource" in input)
      ? { ...input, resource: config.resource } : input;
  }
  const authorizationOrigin = config.authorizationOrigin ?? config.origin;
  const resolveMetadata = createClientMetadataResolver(options.metadataFetch);
  const settings = instanceSettingsService(db);
  const isEnabled = async (queryDb: Db = db) => {
    const experimental = await (queryDb === db ? settings : instanceSettingsService(queryDb)).getExperimental();
    return museAgentConnection ? experimental.enableMuse && experimental.enableNativeRunner : experimental.enablePublicMcp && (!agentConnection || experimental.enableOpenAiDot || (experimental.enableGrokBot && experimental.enableNativeRunner));
  };
  async function assertEnabled(queryDb: Db = db) {
    if (!await isEnabled(queryDb)) throw new PublicMcpDisabledError();
  }
  const boardAuth = boardAuthService(db);

  async function fenceAgentGrant(grant: typeof mcpOauthGrants.$inferSelect | null | undefined) {
    if (grant?.purpose !== "agent" || !grant.agentId) return;
    // A persisted Muse link retains its provider identity after a public-origin
    // configuration change. Revocation must never reinterpret it as a Dot grant.
    const [museBinding] = await db.select({ id: museAgentBindings.id }).from(museAgentBindings)
      .where(and(eq(museAgentBindings.grantId, grant.id), eq(museAgentBindings.companyId, grant.companyId),
        eq(museAgentBindings.agentId, grant.agentId), eq(museAgentBindings.operatorId, grant.userId)));
    if (museBinding) { await revokeMuseOAuthGrant(db, grant); return; }
    const { dotRunnerBroker } = await import("../dot-runner-broker.js");
    await dotRunnerBroker(db).revoke(grant.companyId, grant.agentId, grant.userId, grant.id);
  }

  async function actorForGrant(grant: typeof mcpOauthGrants.$inferSelect, queryDb: Db = db): Promise<Request["actor"]> {
    if (grant.revokedAt || grant.resource !== config.resource) throw invalidGrant();
    const access = await boardAuthService(queryDb).resolveBoardAccess(grant.userId);
    const membership = access.memberships.find((m) => m.companyId === grant.companyId && m.status === "active");
    const [company] = await queryDb.select({ status: companies.status }).from(companies).where(eq(companies.id, grant.companyId));
    if (!access.user || !membership || !company || company.status === "archived") throw invalidGrant();
    if (agentConnection) {
      if (grant.purpose !== "agent" || !grant.scopes.includes("paperclip:agent")) throw invalidGrant();
      if (membership.membershipRole === "viewer") throw invalidGrant();
      if (!grant.agentId) { if(museAgentConnection)throw invalidGrant(); return { type: "none", source: "mcp_oauth", companyId: grant.companyId }; }
      const [agent] = await queryDb.select().from(agents).where(and(eq(agents.id, grant.agentId), eq(agents.companyId, grant.companyId)));
      // Paused Dot connections retain only the broker's fence inbox and ack
      // authority. Each task/tool method independently rejects paused agents.
      if (!agent || ["terminated", "pending_approval"].includes(agent.status)) throw invalidGrant();
      if (museAgentConnection) {
        if(!grant.scopes.includes("offline_access"))throw invalidGrant();
        const [binding] = await queryDb.select().from(museAgentBindings).where(and(
          eq(museAgentBindings.grantId, grant.id), eq(museAgentBindings.companyId, grant.companyId),
          eq(museAgentBindings.agentId, agent.id), eq(museAgentBindings.operatorId, grant.userId), isNull(museAgentBindings.revokedAt),
        ));
        if (!binding || !binding.workerActivityAt || binding.workerActivityAt.getTime() + refreshLifetime <= Date.now()) throw invalidGrant();
        await assertMuseCurrentAuthority(queryDb, binding, true, true);
      }
      return { type: "agent", source: "mcp_oauth", agentId: agent.id, companyId: grant.companyId };
    }
    if (grant.purpose !== "personal") throw invalidGrant();
    return {
      type: "board", source: "mcp_oauth", userId: grant.userId,
      userName: access.user.name, userEmail: access.user.email,
      // Even instance administrators get only the explicitly consented company.
      companyIds: [grant.companyId], memberships: [membership], isInstanceAdmin: false,
    };
  }

  async function issueTokens(tx: Db, grant: typeof mcpOauthGrants.$inferSelect) {
    const access = secret("pcmcp_at_");
    const refresh = grant.scopes.includes("offline_access") ? secret("pcmcp_rt_") : null;
    await tx.insert(mcpOauthTokens).values([
      { grantId: grant.id, tokenHash: hashMcpSecret(access), kind: "access", expiresAt: new Date(Date.now() + accessLifetime) },
      ...(refresh ? [{ grantId: grant.id, tokenHash: hashMcpSecret(refresh), kind: "refresh" as const,
        expiresAt: dotAgentConnection && grant.purpose === "agent" ? null : new Date(Date.now() + refreshLifetime) }] : []),
    ]);
    if (museAgentConnection) await tx.update(museAgentBindings).set({ workerActivityAt: new Date() })
      .where(and(eq(museAgentBindings.grantId, grant.id), isNull(museAgentBindings.revokedAt)));
    return {
      access_token: access, token_type: "Bearer", expires_in: accessLifetime / 1000,
      ...(refresh ? { refresh_token: refresh } : {}), scope: grant.scopes.join(" "),
    };
  }

  async function admitMetadataFetch(source: string) {
    const sourceHash = hashMcpSecret(config.resource + ":" + source);
    // Commit admission before any remote work. Failed metadata/redirect checks
    // must not roll this back; a unique client URL must not reset the quota.
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(736721044)`);
      await tx.delete(mcpOauthMetadataAdmissions).where(lte(mcpOauthMetadataAdmissions.expiresAt, sql`clock_timestamp()`));
      const [counts] = await tx.select({ total: sql<number>`count(*)::int`,
        source: sql<number>`(count(*) FILTER (WHERE ${mcpOauthMetadataAdmissions.sourceHash} = ${sourceHash}))::int`,
      }).from(mcpOauthMetadataAdmissions);
      if (!counts || counts.total >= 60 || counts.source >= 6) {
        throw new McpOAuthError("temporarily_unavailable", "Client metadata verification capacity reached. Retry later.", 429);
      }
      await tx.insert(mcpOauthMetadataAdmissions).values({ sourceHash, expiresAt: sql`clock_timestamp() + interval '1 minute'` });
    }).catch(error => {
      if (error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("temporarily_unavailable", "Client metadata verification is temporarily unavailable. Retry later.", 503);
    });
  }

  async function resolveClient(id: string, source: string) {
    if (!id.startsWith("https://")) {
      const [client] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, id));
      return client ? { ...client, native: false } : undefined;
    }
    let metadata;
    try { metadata = await resolveMetadata(id, () => admitMetadataFetch(source)); }
    catch (error) {
      if (error instanceof McpOAuthError) throw error;
      throw new McpOAuthError("invalid_client_metadata", "Could not verify the client's public metadata.");
    }
    return { id, name: metadata.client_name, redirectUris: metadata.redirect_uris,
      grantTypes: metadata.grant_types, native: metadata.application_type === "native" };
  }

  async function retainMetadataClient(tx: Db, client: NonNullable<Awaited<ReturnType<typeof resolveClient>>>, source: string) {
    if (!client.id.startsWith("https://")) return;
    const sourceHash = hashMcpSecret(config.resource + ":" + source);
    // Caller holds the shared registration lock and has admitted this request.
    await pruneClients(tx);
    const [existing] = await tx.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, client.id));
    if (!existing) await admitClient(tx, sourceHash);
    const value = { name: client.name, redirectUris: client.redirectUris, grantTypes: client.grantTypes };
    await tx.insert(mcpOauthClients).values({ id: client.id, registrationSourceHash: sourceHash, ...value })
      .onConflictDoUpdate({ target: mcpOauthClients.id, set: value });
  }

  async function pruneClients(tx: Db) {
    const now = new Date();
    await tx.delete(mcpOauthRequests).where(lt(mcpOauthRequests.expiresAt, now));
    await tx.delete(mcpOauthDeviceRequests).where(lt(mcpOauthDeviceRequests.expiresAt, now));
    await tx.delete(mcpOauthClients).where(and(
      lt(mcpOauthClients.createdAt, new Date(now.getTime() - 60 * minute)),
      notExists(tx.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId, mcpOauthClients.id))),
      notExists(tx.select({ id: mcpOauthRequests.id }).from(mcpOauthRequests).where(eq(mcpOauthRequests.clientId, mcpOauthClients.id))),
      notExists(tx.select({ id: mcpOauthDeviceRequests.id }).from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.clientId, mcpOauthClients.id))),
    ));
  }

  async function admitClient(tx: Db, sourceHash: string) {
    const [counts] = await tx.select({ total: sql<number>`count(*)::int`,
      sourceTotal: sql<number>`(count(*) FILTER (WHERE ${mcpOauthClients.registrationSourceHash} = ${sourceHash}))::int`,
      sourceRecent: sql<number>`(count(*) FILTER (WHERE ${mcpOauthClients.registrationSourceHash} = ${sourceHash} AND ${mcpOauthClients.createdAt} > ${new Date(Date.now() - minute).toISOString()}::timestamptz))::int`,
      recent: sql<number>`(count(*) FILTER (WHERE ${mcpOauthClients.createdAt} > ${new Date(Date.now() - minute).toISOString()}::timestamptz))::int`,
    }).from(mcpOauthClients).where(notExists(tx.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId, mcpOauthClients.id))));
    if (!counts || counts.total >= 10_000 || counts.recent >= 60 || counts.sourceTotal >= 30 || counts.sourceRecent >= 6) {
      throw new McpOAuthError("temporarily_unavailable", "Registration capacity reached. Retry later.", 429);
    }
  }

  async function consentContext(actor: Request["actor"], requestedCompanyId: string | null) {
    const signedIn = actor.type === "board" && !!actor.userId && ["session", "cloud_tenant"].includes(actor.source ?? "");
    const access = signedIn ? await boardAuth.resolveBoardAccess(actor.userId!) : null;
    const available = access?.user && access.companyIds.length ? await db.select({ id: companies.id, name: companies.name, status: companies.status, logoAssetId: companyLogos.assetId })
      .from(companies).leftJoin(companyLogos, eq(companyLogos.companyId, companies.id)).where(inArray(companies.id, access.companyIds)) : [];
    return { requiresSignIn: !access?.user, companies: available.flatMap((company) => {
      if (requestedCompanyId && company.id !== requestedCompanyId) return [];
      const membership = access?.memberships.find((m) => m.companyId === company.id);
      return membership?.status === "active" && company.status !== "archived"
        ? [{ id: company.id, name: company.name, logoUrl: company.logoAssetId ? `/api/assets/${company.logoAssetId}/content` : null, canWrite: membership.membershipRole !== "viewer" }] : [];
    }) };
  }

  async function approveGrant(tx: Db, actor: Request["actor"], request: { requestedCompanyId: string | null; clientId: string; resource: string; scopes: string[] }, input: { companyId?: string; allowWrites: boolean; allowConfiguration?: boolean }) {
    if (actor.type !== "board" || !actor.userId || !["session", "cloud_tenant"].includes(actor.source ?? "")) throw new McpOAuthError("access_denied", "Sign in to approve an assistant connection.", 401);
    const access = await boardAuthService(tx).resolveBoardAccess(actor.userId);
    const membership = access.memberships.find(m => m.companyId === input.companyId && m.status === "active");
    if (!access.user || !membership || (request.requestedCompanyId && request.requestedCompanyId !== input.companyId)) throw new McpOAuthError("access_denied", "Choose an available organization for this request.", 403);
    const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, input.companyId!));
    if (!company || company.status === "archived") throw new McpOAuthError("access_denied", "This organization is no longer available.", 403);
    if (request.resource !== config.resource) throw invalidGrant();
    if (agentConnection && membership.membershipRole === "viewer") throw new McpOAuthError("access_denied", "Dot agent connections require an operator role.", 403);
    if ((input.allowWrites || input.allowConfiguration) && membership.membershipRole === "viewer") throw new McpOAuthError("access_denied", "Viewer access is read-only.", 403);
    const scopes = request.scopes.filter(s => (s !== "paperclip:write" || input.allowWrites)
      && (s !== "paperclip:configure" || input.allowConfiguration === true));
    const [grant] = await tx.insert(mcpOauthGrants).values({ companyId: input.companyId!, userId: actor.userId, clientId: request.clientId, resource: request.resource, scopes, purpose: agentConnection ? "agent" : "personal" }).returning();
    await tx.insert(activityLog).values({ companyId: grant!.companyId, actorType: "user", actorId: actor.userId,
      action: "mcp.connection_authorized", entityType: "mcp_connection", entityId: grant!.id, details: { clientId: grant!.clientId, scopes } });
    return grant!;
  }

  function deviceHash(code: string) { return hashMcpSecret(code.toUpperCase().replaceAll("-", "").replaceAll(" ", "")); }
  async function deviceToken(input: Record<string, unknown>, clientId: string) {
    if (typeof input.device_code !== "string") throw invalidGrant();
    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.deviceCodeHash, hashMcpSecret(input.device_code as string))).for("update");
      if (!row || row.clientId !== clientId || row.resource !== config.resource || row.status === "consumed") return { error: "invalid_grant" };
      const now = new Date();
      if (row.expiresAt <= now) return { error: "expired_token" };
      if (row.status === "denied") return { error: "access_denied" };
      if (row.nextPollAt > now) {
        const intervalSeconds = row.intervalSeconds + 5;
        await tx.update(mcpOauthDeviceRequests).set({ intervalSeconds, nextPollAt: new Date(now.getTime() + intervalSeconds * 1000) }).where(eq(mcpOauthDeviceRequests.id, row.id));
        return { error: "slow_down" };
      }
      await tx.update(mcpOauthDeviceRequests).set({ nextPollAt: new Date(now.getTime() + row.intervalSeconds * 1000) }).where(eq(mcpOauthDeviceRequests.id, row.id));
      if (row.status !== "approved" || !row.grantId) return { error: "authorization_pending" };
      const [grant] = await tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, row.grantId)).for("update");
      if (!grant) return { error: "invalid_grant" };
      await actorForGrant(grant, tx as unknown as Db);
      await tx.update(mcpOauthDeviceRequests).set({ status: "consumed" }).where(eq(mcpOauthDeviceRequests.id, row.id));
      return { tokens: await issueTokens(tx as unknown as Db, grant) };
    });
    if (outcome.error) throw new McpOAuthError(outcome.error, "Device authorization is pending, denied, expired, or polling too quickly. Follow the returned OAuth error.");
    return outcome.tokens!;
  }

  async function dotPairingContext(queryDb: Db, id: string, pairingCode: string) {
    if (!dotAgentConnection) throw new McpOAuthError("access_denied", "Use the dedicated Dot agent connection.", 403);
    if (!/^[A-Za-z0-9_-]{32}$/.test(pairingCode)) throw invalidGrant();
    await assertEnabled(queryDb);
    const [request] = await queryDb.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.id, id)).for("update");
    if (!request || request.resource !== config.resource || request.decidedAt || request.expiresAt <= new Date()) throw invalidGrant();
    const [binding] = await queryDb.select().from(dotAgentBindings).where(and(
      eq(dotAgentBindings.pairingCodeHash, hashMcpSecret(pairingCode)), isNull(dotAgentBindings.revokedAt),
    )).for("update");
    if (!binding || !await externalBotEnabled(queryDb, binding.providerKind) || binding.status !== "pairing" || binding.grantId || !binding.pairingExpiresAt || binding.pairingExpiresAt <= new Date()) throw invalidGrant();
    if (request.requestedCompanyId && request.requestedCompanyId !== binding.companyId) throw invalidGrant();
    const [agent] = await queryDb.select().from(agents).where(and(eq(agents.id, binding.agentId), eq(agents.companyId, binding.companyId))).for("update");
    if (!agent || agent.adapterType !== "paperclip_runner" || agent.adapterConfig.provider !== binding.providerKind || !canConfigureAgentConnection(agent)) throw invalidGrant();
    if (binding.providerKind === "grok_bot") await authorizeExternalBotOperator(queryDb, binding.companyId, binding.operatorId);
    return { request, binding, agent };
  }

  /** Exact Muse grant revocation uses the same prefix as token and work effects. */
  async function revokeGrantTransaction<T>(grant:typeof mcpOauthGrants.$inferSelect,operation:(tx:Db)=>Promise<T>) {
    const [candidate]=grant.purpose==="agent"&&grant.agentId
      ? await db.select().from(museAgentBindings).where(and(eq(museAgentBindings.grantId,grant.id),
          eq(museAgentBindings.companyId,grant.companyId),eq(museAgentBindings.agentId,grant.agentId),eq(museAgentBindings.operatorId,grant.userId))) : [];
    if(!candidate)return db.transaction(tx=>operation(tx as unknown as Db));
    return db.transaction(tx=>withExternalAdmissionGuard(tx,candidate.companyId,candidate.agentId,async()=>{
      await tx.select({id:museAgentBindings.id}).from(museAgentBindings).where(and(eq(museAgentBindings.id,candidate.id),eq(museAgentBindings.grantId,grant.id))).for("update");
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance, "*");
      return operation(tx as unknown as Db);
    }));
  }

  /** Muse token rotation shares the broker's admission -> binding lock prefix. */
  async function tokenTransaction<T>(kind:"code"|"refresh",hash:string,operation:(tx:Db,lockedGrantId:string|null)=>Promise<T>,observation?:MuseCodeExchangeObservation) {
    if(!museAgentConnection)return db.transaction(tx=>operation(tx as unknown as Db,null));
    const [source]=kind==="code"
      ? await db.select({grantId:mcpOauthRequests.grantId}).from(mcpOauthRequests).where(eq(mcpOauthRequests.codeHash,hash))
      : await db.select({grantId:mcpOauthTokens.grantId}).from(mcpOauthTokens).where(and(eq(mcpOauthTokens.tokenHash,hash),eq(mcpOauthTokens.kind,"refresh")));
    if(!source?.grantId)throw invalidGrant();
    const [candidate]=await db.select().from(museAgentBindings).where(and(eq(museAgentBindings.grantId,source.grantId),isNull(museAgentBindings.revokedAt)));
    if(candidate)observeMuseCodeBinding(observation,candidate);
    if(!candidate){decideMuseCodeExchange(observation,["binding_unavailable"]);throw invalidGrant();}
    return db.transaction(tx=>withExternalAdmissionGuard(tx,candidate.companyId,candidate.agentId,async()=>{
      const [binding]=await tx.select().from(museAgentBindings).where(and(eq(museAgentBindings.id,candidate.id),
        eq(museAgentBindings.grantId,source.grantId!),eq(museAgentBindings.generation,candidate.generation),isNull(museAgentBindings.revokedAt))).for("update");
      if(!binding){decideMuseCodeExchange(observation,["binding_unavailable"]);throw invalidGrant();}
      try { await assertMuseCurrentAuthority(tx,binding,true,true); }
      catch(error){if(error instanceof HttpError&&error.status===403){decideMuseCodeExchange(observation,["current_authority_unavailable"]);throw invalidGrant();}throw error;}
      return operation(tx as unknown as Db,source.grantId!);
    }));
  }

  async function exchangeAuthorizationCode(input:Record<string,unknown>,clientId:string,observation?:MuseCodeExchangeObservation) {
    const codeHash=typeof input.code==="string"?hashMcpSecret(input.code):null;
    try {
      if(typeof input.code!=="string"||typeof input.code_verifier!=="string"||!/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) {
        decideMuseCodeExchange(observation,["verifier_format"]);
        throw invalidGrant();
      }
      const challenge=createHash("sha256").update(input.code_verifier).digest("base64url");
      const tokens=await tokenTransaction("code",codeHash!,async(tx,lockedGrantId)=>{
        const [row]=await tx.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.codeHash,codeHash!)).for("update");
        if(!row)throw invalidGrant();
        const failedChecks:MuseCodeExchangeCheck[]=[];
        if(row.clientId!==clientId)failedChecks.push("client_mismatch");
        if(row.redirectUri!==input.redirect_uri)failedChecks.push("redirect_mismatch");
        if(row.resource!==config.resource)failedChecks.push("resource_mismatch");
        if(row.challenge!==challenge)failedChecks.push("pkce_mismatch");
        if(row.consumedAt)failedChecks.push("code_consumed");
        if(row.expiresAt<=new Date())failedChecks.push("code_expired");
        if(!row.grantId)failedChecks.push("grant_unavailable");
        if(museAgentConnection&&row.grantId!==lockedGrantId)failedChecks.push("binding_unavailable");
        if(failedChecks.length){decideMuseCodeExchange(observation,failedChecks,row);throw invalidGrant();}
        const [grant]=await tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id,row.grantId!)).for("update");
        if(!grant){decideMuseCodeExchange(observation,["grant_unavailable"],row);throw invalidGrant();}
        try { await actorForGrant(grant,tx as unknown as Db); }
        catch(error){
          if((error instanceof McpOAuthError&&error.code==="invalid_grant")||(error instanceof HttpError&&error.status===403))decideMuseCodeExchange(observation,["current_authority_unavailable"],row);
          if(museAgentConnection&&error instanceof HttpError&&error.status===403)throw invalidGrant();
          throw error;
        }
        decideMuseCodeExchange(observation,[],row);
        await tx.update(mcpOauthRequests).set({consumedAt:new Date()}).where(eq(mcpOauthRequests.id,row.id));
        const result=await issueTokens(tx as unknown as Db,grant);
        if(observation)await recordMuseCodeSuccess(tx as unknown as Db,observation,row,grant);
        return result;
      },observation);
      if(observation)publishMuseCodeActivities(observation.publications);
      return tokens;
    } catch(error) {
      if(observation&&codeHash)await recordMuseCodeRejection(db,config.resource,codeHash,observation);
      throw error;
    }
  }

  async function authenticateToken(token: string, museStopControl = false): Promise<McpPrincipal & { accessTokenId: string }> {
      if(!museAgentConnection||!museStopControl)await assertEnabled();
      const [row] = await db.select({ token: mcpOauthTokens, grant: mcpOauthGrants, company: { id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix, status: companies.status } })
        .from(mcpOauthTokens).innerJoin(mcpOauthGrants, eq(mcpOauthTokens.grantId, mcpOauthGrants.id))
        .innerJoin(companies, eq(companies.id, mcpOauthGrants.companyId))
        .where(and(eq(mcpOauthTokens.tokenHash, hashMcpSecret(token)), eq(mcpOauthTokens.kind, "access"),
          gt(mcpOauthTokens.expiresAt, new Date()), isNull(mcpOauthGrants.revokedAt)));
      if (!row) throw new McpOAuthError("invalid_token", "Connect Paperclip again.", 401);
      try { return { grant: row.grant, company: row.company, actor: await actorForGrant(row.grant), accessTokenId: row.token.id }; }
      catch (error) { if (museAgentConnection && !(error instanceof McpOAuthError) && !(error instanceof HttpError && [401,403,404,410].includes(error.status))) throw error; throw new McpOAuthError("invalid_token", "Paperclip access is no longer available.", 401); }
  }

  const authenticateAccess=(token:string)=>authenticateToken(token);

  return {
    config, mode, issuer, isEnabled, assertEnabled,
    async ownsRequest(id: string) {
      const [row] = await db.select({ resource: mcpOauthRequests.resource }).from(mcpOauthRequests).where(eq(mcpOauthRequests.id, id));
      return row?.resource === config.resource;
    },
    async ownsDevice(userCode: string) {
      const [row] = await db.select({ resource: mcpOauthDeviceRequests.resource }).from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.userCodeHash, deviceHash(userCode)));
      return row?.resource === config.resource;
    },
    async deviceAuthorize(input: unknown, source = "unknown") {
      if (museAgentConnection) throw new McpOAuthError("unsupported_grant_type", "Muse requires public-client PKCE authorization.");
      await assertEnabled();
      const p = z.object({ client_id: z.string().min(1).max(2048), resource: z.literal(config.resource), scope: z.string().max(200).default(requiredScope), company_id: z.uuid().optional() }).safeParse(input);
      if (!p.success) throw new McpOAuthError("invalid_request", "Supply a registered client and the exact Paperclip resource.");
      const scopes = [...new Set(p.data.scope.split(/\s+/).filter(Boolean))];
      if (!scopes.includes(requiredScope) || scopes.some(s => !(scopesSupported as readonly string[]).includes(s))) throw new McpOAuthError("invalid_scope", "Unsupported Paperclip scope.");
      const client = await resolveClient(p.data.client_id, source);
      if (!client?.grantTypes.includes(DEVICE_GRANT)) throw new McpOAuthError("unauthorized_client", "Register a device authorization client.");
      const deviceCode = secret("pcmcp_device_");
      const alphabet = "BCDFGHJKLMNPQRSTVWXYZ23456789";
      const chars = Array.from(randomBytes(8), byte => alphabet[byte % alphabet.length]).join("");
      const userCode = chars.slice(0, 4) + "-" + chars.slice(4);
      const sourceHash = hashMcpSecret(config.resource + ":" + source);
      await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(736721043)`);
        const now = new Date();
        await tx.delete(mcpOauthDeviceRequests).where(lt(mcpOauthDeviceRequests.expiresAt, now));
        const [count] = await tx.select({ total: sql<number>`count(*)::int`, source: sql<number>`(count(*) FILTER (WHERE ${mcpOauthDeviceRequests.sourceHash} = ${sourceHash}))::int` }).from(mcpOauthDeviceRequests);
        if (!count || count.total >= 1000 || count.source >= 10) throw new McpOAuthError("temporarily_unavailable", "Too many device connection attempts. Try again later.", 429);
        await retainMetadataClient(tx as unknown as Db, client, source);
        await tx.insert(mcpOauthDeviceRequests).values({ clientId: client.id, deviceCodeHash: hashMcpSecret(deviceCode), userCodeHash: deviceHash(userCode),
          resource: config.resource, scopes, requestedCompanyId: p.data.company_id ?? null, sourceHash, expiresAt: new Date(now.getTime() + 10 * minute) });
      });
      return { device_code: deviceCode, user_code: userCode, verification_uri: authorizationOrigin + "/mcp-device", verification_uri_complete: authorizationOrigin + "/mcp-device?user_code=" + userCode, expires_in: 600, interval: 5 };
    },
    async describeDevice(userCode: string, actor: Request["actor"]): Promise<McpConnectionRequest> {
      await assertEnabled();
      const [row] = await db.select({ request: mcpOauthDeviceRequests, client: mcpOauthClients }).from(mcpOauthDeviceRequests)
        .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthDeviceRequests.clientId))
        .where(and(eq(mcpOauthDeviceRequests.userCodeHash, deviceHash(userCode)), eq(mcpOauthDeviceRequests.status, "pending"), gt(mcpOauthDeviceRequests.expiresAt, new Date())));
      if (!row || row.request.resource !== config.resource) throw new McpOAuthError("invalid_request", "This code is expired, already decided, or invalid. Start a new connection from your assistant.", 404);
      return { agentConnection, id: row.request.id, clientName: row.client.name, redirectOrigin: "", clientOrigin: row.client.id.startsWith("https://") ? new URL(row.client.id).origin : null,
        requestedConfigure: row.request.scopes.includes("paperclip:configure"), requestedWrite: row.request.scopes.includes("paperclip:write"), offlineAccess: row.request.scopes.includes("offline_access"), requestedCompanyId: row.request.requestedCompanyId,
        setupUrl: null, ...await consentContext(actor, row.request.requestedCompanyId) };
    },
    async consentDevice(userCode: string, actor: Request["actor"], input: { decision: "approve" | "deny"; companyId?: string; allowWrites: boolean; allowConfiguration?: boolean }) {
      await assertEnabled();
      if (actor.type !== "board" || !actor.userId || !["session", "cloud_tenant"].includes(actor.source ?? "")) throw new McpOAuthError("access_denied", "Sign in to approve a connection.", 401);
      return db.transaction(async tx => {
        const [row] = await tx.select().from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.userCodeHash, deviceHash(userCode))).for("update");
        if (!row || row.resource !== config.resource || row.status !== "pending" || row.expiresAt <= new Date()) throw invalidGrant();
        const grant = input.decision === "approve" ? await approveGrant(tx as unknown as Db, actor, row, input) : null;
        await tx.update(mcpOauthDeviceRequests).set({ status: grant ? "approved" : "denied", grantId: grant?.id ?? null }).where(eq(mcpOauthDeviceRequests.id, row.id));
        return { status: grant ? "approved" as const : "denied" as const };
      });
    },
    async register(input: unknown, source = "unknown") {
      await assertEnabled();
      const parsed = registrationSchema.safeParse(input);
      if (!parsed.success) throw new McpOAuthError("invalid_client_metadata", "Supply a client name, valid redirect URIs, and public-client PKCE authentication.");
      if (museAgentConnection && parsed.data.grant_types.some(type => type !== "authorization_code" && type !== "refresh_token")) throw new McpOAuthError("invalid_client_metadata", "Muse supports authorization code and rotating refresh only.");
      if (parsed.data.grant_types.includes("authorization_code") && parsed.data.redirect_uris.length === 0) throw new McpOAuthError("invalid_client_metadata", "Authorization code clients need a redirect URI.");
      const client = { id: secret("pcmcp_client_"), name: parsed.data.client_name, registrationSourceHash: hashMcpSecret(config.resource + ":" + source), redirectUris: parsed.data.redirect_uris, grantTypes: parsed.data.grant_types };
      await db.transaction(async (tx) => {
        // Bound public DCR across replicas, not only per-IP in each process.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
        await pruneClients(tx as unknown as Db);
        await admitClient(tx as unknown as Db, client.registrationSourceHash);
        await tx.insert(mcpOauthClients).values(client);
      });
      return { ...parsed.data, client_id: client.id, client_id_issued_at: Math.floor(Date.now() / 1000) };
    },
    async authorize(input: unknown, source = "unknown") {
      await assertEnabled();
      const parsed = authorizeSchema.extend({ scope: z.string().max(200).default(defaultScope), pairing_ticket: z.string().min(20).max(200).optional() }).safeParse(withResource(input));
      if (!parsed.success) throw new McpOAuthError("invalid_request", "A registered client, exact redirect URI, resource, and S256 PKCE challenge are required.");
      const p = parsed.data;
      if (p.resource !== config.resource) throw new McpOAuthError("invalid_target", "Resource does not match this Paperclip MCP endpoint.");
      const scopes = [...new Set(p.scope.split(/\s+/).filter(Boolean))];
      if (!scopes.includes(requiredScope) || (museAgentConnection && !scopes.includes("offline_access")) || scopes.some((s) => !(scopesSupported as readonly string[]).includes(s))) {
        throw new McpOAuthError("invalid_scope", "Unsupported Paperclip scope.");
      }
      if (museAgentConnection && p.client_id.startsWith("https://")) throw new McpOAuthError("invalid_request", "Muse requires a registered public PKCE client.");
      const client = await resolveClient(p.client_id, source);
      if (!client || !client.grantTypes.includes("authorization_code") || !mcpRedirectMatches(client.redirectUris, p.redirect_uri, client.native)) {
        throw new McpOAuthError("invalid_request", "Unknown client or redirect URI.");
      }
      const id = secret("pcmcp_request_");
      if (museAgentConnection) {
        if (!p.pairing_ticket) throw new McpOAuthError("invalid_request", "A one-use Muse pairing ticket is required.");
        const [candidate] = await db.select().from(museAgentBindings).where(eq(museAgentBindings.ticketHash, hashMcpSecret(p.pairing_ticket)));
        if (!candidate) throw invalidGrant();
        return db.transaction(tx => withExternalAdmissionGuard(tx, candidate.companyId, candidate.agentId, async () => {
          const [binding] = await tx.select().from(museAgentBindings).where(and(eq(museAgentBindings.id, candidate.id),
            eq(museAgentBindings.ticketHash, hashMcpSecret(p.pairing_ticket!)), eq(museAgentBindings.status, "pairing"),
            isNull(museAgentBindings.grantId), isNull(museAgentBindings.revokedAt), gt(museAgentBindings.ticketExpiresAt, new Date()))).for("update");
          if (!binding || (p.company_id && p.company_id !== binding.companyId)) throw invalidGrant();
          await assertMuseCurrentAuthority(tx, binding, true);
          const now = new Date(), code = secret("pcmcp_code_");
          const [grant] = await tx.insert(mcpOauthGrants).values({ companyId: binding.companyId, agentId: binding.agentId,
            userId: binding.operatorId, clientId: client.id, resource: config.resource, scopes, purpose: "agent" }).returning();
          await tx.insert(mcpOauthRequests).values({ id, clientId: client.id, redirectUri: p.redirect_uri, resource: config.resource,
            scopes, requestedCompanyId: binding.companyId, state: p.state ?? null, challenge: p.code_challenge,
            grantId: grant.id, codeHash: hashMcpSecret(code), decidedAt: now, expiresAt: new Date(now.getTime() + minute) });
          await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance, "*");
          await tx.update(museAgentBindings).set({ grantId: grant.id, status: "connected", pairedAt: now, workerActivityAt: now,
            ticketHash: null, ticketExpiresAt: null, clientVersion: null, revision: binding.revision + 1, updatedAt: now }).where(eq(museAgentBindings.id, binding.id));
          await logActivity(tx as unknown as Db, { companyId: binding.companyId, actorType: "user", actorId: binding.operatorId,
            action: "muse.paired", entityType: "agent", entityId: binding.agentId,
            details: { bindingId: binding.id, generation: binding.generation, grantId: grant.id, via: "oauth_pkce_ticket" } });
          const redirect = new URL(p.redirect_uri); redirect.searchParams.set("iss", issuer);
          if (p.state !== undefined) redirect.searchParams.set("state", p.state);
          redirect.searchParams.set("code", code); return redirect.toString();
        }));
      }
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
        const now = new Date();
        await tx.delete(mcpOauthRequests).where(lt(mcpOauthRequests.expiresAt, now));
        const [counts] = await tx.select({ total: sql<number>`count(*)::int`,
          client: sql<number>`(count(*) FILTER (WHERE ${mcpOauthRequests.clientId} = ${client.id}))::int`,
        }).from(mcpOauthRequests).where(isNull(mcpOauthRequests.decidedAt));
        if (!counts || counts.total >= 1000 || counts.client >= 10) {
          throw new McpOAuthError("temporarily_unavailable", "Too many pending connection requests. Retry later.", 429);
        }
        await retainMetadataClient(tx as unknown as Db, client, source);
        await tx.insert(mcpOauthRequests).values({
          id, clientId: client.id, redirectUri: p.redirect_uri, resource: p.resource, scopes,
          requestedCompanyId: p.company_id ?? null,
          state: p.state ?? null, challenge: p.code_challenge, expiresAt: new Date(now.getTime() + 10 * minute),
        });
      });
      return authorizationOrigin + (agentConnection ? "/dot-connect/" : "/mcp-connect/") + id;
    },
    async describeRequest(id: string, actor: Request["actor"], setupUrl: string | null): Promise<McpConnectionRequest> {
      await assertEnabled();
      const [row] = await db.select({ request: mcpOauthRequests, client: mcpOauthClients })
        .from(mcpOauthRequests).innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthRequests.clientId))
        .where(and(eq(mcpOauthRequests.id, id), isNull(mcpOauthRequests.decidedAt), gt(mcpOauthRequests.expiresAt, new Date())));
      if (!row || row.request.resource !== config.resource) throw new McpOAuthError("invalid_request", "Connection request is expired or already decided.", 404);
      return {
        agentConnection, id, clientName: row.client.name, redirectOrigin: new URL(row.request.redirectUri).origin,
        clientOrigin: row.client.id.startsWith("https://") ? new URL(row.client.id).origin : null,
        requestedConfigure: row.request.scopes.includes("paperclip:configure"), requestedWrite: row.request.scopes.includes("paperclip:write"), offlineAccess: row.request.scopes.includes("offline_access"),
        requestedCompanyId: row.request.requestedCompanyId,
        ...await consentContext(actor, row.request.requestedCompanyId), setupUrl,
      };
    },
    async consent(id: string, actor: Request["actor"], input: { decision: "approve" | "deny"; companyId?: string; allowWrites: boolean; allowConfiguration?: boolean }) {
      if (museAgentConnection) throw new McpOAuthError("access_denied", "Muse uses an operator-authorized pairing ticket, not personal MCP consent.");
      await assertEnabled();
      if (actor.type !== "board" || !actor.userId || !["session", "cloud_tenant"].includes(actor.source ?? "")) {
        throw new McpOAuthError("access_denied", "Sign in to approve an assistant connection.", 401);
      }
      const access = await boardAuth.resolveBoardAccess(actor.userId);
      const membership = access.memberships.find((m) => m.companyId === input.companyId && m.status === "active");
      if (!access.user || (input.decision === "approve" && !membership)) {
        throw new McpOAuthError("access_denied", "Choose a company you belong to.", 403);
      }
      const result = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.id, id)).for("update");
        if (!row || row.resource !== config.resource || row.decidedAt || row.expiresAt <= new Date()) throw invalidGrant();
        const redirect = new URL(row.redirectUri);
        redirect.searchParams.set("iss", issuer);
        if (row.state !== null) redirect.searchParams.set("state", row.state);
        if (input.decision === "deny") {
          await tx.update(mcpOauthRequests).set({ decidedAt: new Date() }).where(eq(mcpOauthRequests.id, id));
          redirect.searchParams.set("error", "access_denied");
          return { redirectUrl: redirect.toString(), grant: null };
        }
        if (row.requestedCompanyId && input.companyId !== row.requestedCompanyId) {
          throw new McpOAuthError("access_denied", "This request is for a different organization. Start a new connection to change organizations.", 403);
        }
        const grant = await approveGrant(tx as unknown as Db, actor, row, input);
        const code = secret("pcmcp_code_");
        await tx.update(mcpOauthRequests).set({
          grantId: grant!.id, codeHash: hashMcpSecret(code), decidedAt: new Date(), expiresAt: new Date(Date.now() + minute),
        }).where(eq(mcpOauthRequests.id, id));
        redirect.searchParams.set("code", code);
        return { redirectUrl: redirect.toString(), grant };
      });
      return { redirectUrl: result.redirectUrl };
    },
    async describeDotPairing(id: string, pairingCode: string): Promise<McpDotPairingPreview> {
      return db.transaction(async tx => {
        const { binding, agent } = await dotPairingContext(tx as unknown as Db, id, pairingCode);
        const access = await boardAuthService(tx as unknown as Db).resolveBoardAccess(binding.operatorId);
        const membership = access.memberships.find(m => m.companyId === binding.companyId && m.status === "active");
        const [company] = await tx.select().from(companies).where(eq(companies.id, binding.companyId));
        if (!access.user || !membership || membership.membershipRole === "viewer" || !company || company.status === "archived") throw invalidGrant();
        return { providerKind: binding.providerKind, authorizingPerson: access.user.name,
          company: { id: company.id, name: company.name }, agent: { id: agent.id, name: agent.name },
          permissions: binding.providerKind === "grok_bot" ? "Work as this agent: find and create permitted tasks, claim admitted work sessions, report progress, ask questions, save documents and deliverables, and submit completion for normal review. Execution requires a current task-bound session. No board account or other-company access. Grok plugins are account-wide; linking this Bot does not isolate credentials from other Bots on your Grok account. Grok retains its own connected apps. Usage and spending are not reported." : "Start and accept work as this agent, coordinate permitted tasks and people, read assigned skills, and use assigned app tools. Reading assigned task attachment contents sends those contents to OpenAI and requires the agent’s separate attachment setting. Workspace files and sandboxed commands require the agent’s separate workspace setting. No board account or other-company access.",
          accessDuration: "Ongoing until revoked. This connection does not expire from inactivity.",
          pairingExpiresAt: binding.pairingExpiresAt!.toISOString() };
      });
    },
    // Pair Dot records the operator's approval in an expiring capability. It
    // conveys only agent access, never a board session or personal MCP access.
    async consentDotPairing(id: string, pairingCode: string) {
      await assertEnabled();
      if (!dotAgentConnection) throw new McpOAuthError("access_denied", "Use the dedicated Dot agent connection.", 403);
      if (!/^[A-Za-z0-9_-]{32}$/.test(pairingCode)) throw invalidGrant();
      return db.transaction(async tx => {
        const { request, binding, agent } = await dotPairingContext(tx as unknown as Db, id, pairingCode);
        const grant = await approveGrant(tx as unknown as Db,
          { type: "board", source: "session", userId: binding.operatorId }, request,
          { companyId: binding.companyId, allowWrites: false, allowConfiguration: false });
        await tx.update(mcpOauthGrants).set({ agentId: binding.agentId }).where(eq(mcpOauthGrants.id, grant.id));
        await tx.update(dotAgentBindings).set({ grantId: grant.id, status: "connected", pairingCodeHash: null,
          pairingExpiresAt: null, updatedAt: new Date() }).where(eq(dotAgentBindings.id, binding.id));
        await updateAgentConfigurationInTransaction(tx as unknown as Db, agent.id, { adapterConfig: { ...agent.adapterConfig, [binding.providerKind === "grok_bot" ? "externalBindingId" : "dotBindingId"]: binding.id } },
          { recordRevision: { createdByUserId: binding.operatorId, source: "dot-pairing" } });
        await logActivity(tx as unknown as Db, { companyId: binding.companyId, actorType: "user", actorId: binding.operatorId,
          action: "dot.paired", entityType: "agent", entityId: binding.agentId,
          details: { bindingId: binding.id, generation: binding.generation, via: "oauth_pairing_code" } });
        const code = secret("pcmcp_code_");
        await tx.update(mcpOauthRequests).set({ grantId: grant.id, codeHash: hashMcpSecret(code), decidedAt: new Date(),
          expiresAt: new Date(Date.now() + minute) }).where(eq(mcpOauthRequests.id, id));
        const redirect = new URL(request.redirectUri);
        redirect.searchParams.set("iss", issuer);
        if (request.state !== null) redirect.searchParams.set("state", request.state);
        redirect.searchParams.set("code", code);
        return { redirectUrl: redirect.toString() };
      });
    },
    async token(input: Record<string, unknown>) {
      const observation=museAgentConnection&&input.grant_type==="authorization_code"?beginMuseCodeExchange(new Date()):undefined;
      await assertEnabled();
      const clientId = typeof input.client_id === "string" ? input.client_id : "";
      input = withResource(input) as Record<string, unknown>;
      if (!clientId || input.resource !== config.resource) {
        if(observation&&typeof input.code==="string") {
          const failedChecks:MuseCodeExchangeCheck[]=[];
          if(!clientId)failedChecks.push("client_mismatch");
          if(input.resource!==config.resource)failedChecks.push("resource_mismatch");
          decideMuseCodeExchange(observation,failedChecks);
          await recordMuseCodeRejection(db,config.resource,hashMcpSecret(input.code),observation);
        }
        throw new McpOAuthError("invalid_target", "Client and matching resource are required.");
      }
      if (input.grant_type === DEVICE_GRANT) { if(museAgentConnection)throw new McpOAuthError("unsupported_grant_type", "Muse requires PKCE."); return deviceToken(input, clientId); }
      if (input.grant_type === "authorization_code") {
        return exchangeAuthorizationCode(input,clientId,observation);
      }
      if (input.grant_type === "refresh_token") {
        if (typeof input.refresh_token !== "string") throw invalidGrant();
        const tokenHash = hashMcpSecret(input.refresh_token);
        // A replay revokes the whole grant. Commit that revocation before returning an error.
        let revokedGrant: typeof mcpOauthGrants.$inferSelect | null = null;
        const result = await tokenTransaction("refresh",tokenHash,async (tx,lockedGrantId) => {
          const [token] = await tx.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash, tokenHash)).for("update");
          if (!token || token.kind !== "refresh" || (museAgentConnection&&token.grantId!==lockedGrantId)) return null;
          const [grant] = await tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, token.grantId)).for("update");
          if (!grant || grant.clientId !== clientId || grant.resource !== config.resource || grant.revokedAt) return null;
          if (token.usedAt) {
            if (museAgentConnection) await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance, "*");
            await tx.update(mcpOauthGrants).set({ revokedAt: new Date() }).where(eq(mcpOauthGrants.id, grant.id));
            revokedGrant = grant;
            await tx.insert(activityLog).values({
              companyId: grant.companyId, actorType: "system", actorId: "mcp_oauth",
              action: "mcp.connection_revoked", entityType: "mcp_connection", entityId: grant.id,
              details: { clientId: grant.clientId, reason: "refresh_token_replay" },
            });
            return null;
          }
          // Only agent connections support refresh tokens without an inactivity limit.
          // Access tokens still expire, refresh still rotates, and replay still revokes.
          if (token.expiresAt ? token.expiresAt <= new Date() : !dotAgentConnection || grant.purpose !== "agent") return null;
          await actorForGrant(grant, tx as unknown as Db);
          if (input.scope !== undefined && input.scope !== grant.scopes.join(" ")) {
            throw new McpOAuthError("invalid_scope", "Refresh cannot change the consented scopes; reconnect instead.");
          }
          await tx.update(mcpOauthTokens).set({ usedAt: new Date() }).where(eq(mcpOauthTokens.id, token.id));
          return issueTokens(tx as unknown as Db, grant);
        });
        await fenceAgentGrant(revokedGrant);
        if (!result) throw invalidGrant();
        return result;
      }
      throw new McpOAuthError("unsupported_grant_type", "Unsupported authorization grant.");
    },
    async authorizeGrant(grantId: string, queryDb: Db = db): Promise<McpPrincipal> {
      await assertEnabled(queryDb);
      const [row] = await queryDb.select({ grant: mcpOauthGrants, company: { id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix, status: companies.status } })
        .from(mcpOauthGrants).innerJoin(companies, eq(mcpOauthGrants.companyId, companies.id))
        .where(eq(mcpOauthGrants.id, grantId));
      if (!row || !row.grant.scopes.includes(requiredScope)) throw invalidGrant();
      return { ...row, actor: await actorForGrant(row.grant, queryDb) };
    },
    authenticateAccess,
    /** This authenticates only a Muse token; the Muse boundary must independently
     * admit its bounded stop control. Personal MCP and Dot keep their normal gate. */
    async authenticateMuseStopControlAccess(token:string) {
      if(!museAgentConnection)throw new McpOAuthError("access_denied","Use the dedicated Muse stop control.",403);
      return authenticateToken(token,true);
    },
    async authenticate(token: string): Promise<McpPrincipal> {
      const principal = await authenticateAccess(token);
      return { grant: principal.grant, company: principal.company, actor: principal.actor };
    },
    async revokeToken(token: string, clientId: string) {
      const [candidate]=await db.select({grant:mcpOauthGrants}).from(mcpOauthTokens).innerJoin(mcpOauthGrants,eq(mcpOauthGrants.id,mcpOauthTokens.grantId))
        .where(and(eq(mcpOauthTokens.tokenHash,hashMcpSecret(token)),eq(mcpOauthGrants.clientId,clientId),eq(mcpOauthGrants.resource,config.resource)));
      if(!candidate)return;
      const grant=await revokeGrantTransaction(candidate.grant,async tx=>{
        const [row]=await tx.select({grant:mcpOauthGrants}).from(mcpOauthTokens).innerJoin(mcpOauthGrants,eq(mcpOauthGrants.id,mcpOauthTokens.grantId))
          .where(and(eq(mcpOauthTokens.tokenHash,hashMcpSecret(token)),eq(mcpOauthGrants.clientId,clientId),eq(mcpOauthGrants.resource,config.resource)));
        if(!row)return;
        const [revoked]=await tx.update(mcpOauthGrants).set({revokedAt:new Date()}).where(and(eq(mcpOauthGrants.id,row.grant.id),isNull(mcpOauthGrants.revokedAt))).returning();
        if(revoked)await tx.insert(activityLog).values({companyId:revoked.companyId,actorType:"user",actorId:revoked.userId,action:"mcp.connection_revoked",entityType:"mcp_connection",entityId:revoked.id,details:{clientId,reason:"oauth_revocation"}});
        return row.grant;
      });
      await fenceAgentGrant(grant);
    },
    async listConnections(userId: string) {
      const rows = await db.select({ grant: mcpOauthGrants, clientName: mcpOauthClients.name, companyName: companies.name, companyPrefix: companies.issuePrefix, userName: authUsers.name, userImage: authUsers.image, agent: { id: agents.id, name: agents.name, config: agents.adapterConfig } })
        .from(mcpOauthGrants).innerJoin(mcpOauthClients, eq(mcpOauthGrants.clientId, mcpOauthClients.id))
        .innerJoin(companies, eq(companies.id, mcpOauthGrants.companyId))
        .leftJoin(authUsers, eq(authUsers.id, mcpOauthGrants.userId))
        .leftJoin(agents, and(eq(agents.id, mcpOauthGrants.agentId), eq(agents.companyId, mcpOauthGrants.companyId)))
        .where(eq(mcpOauthGrants.userId, userId));
      return rows.map(({ grant, clientName, companyName, companyPrefix, userName, userImage, agent }) => ({
        id: grant.id, companyId: grant.companyId, clientName, companyName, companyPrefix,
        agent: agent ? { id: agent.id, name: agent.name, provider: String(agent.config.provider ?? "") } : null,
        user: userName === null ? null : { name: userName, image: userImage }, scopes: grant.scopes,
        createdAt: grant.createdAt.toISOString(), revokedAt: grant.revokedAt?.toISOString() ?? null,
      }));
    },
    async revokeConnection(id: string, userId: string) {
      const [candidate]=await db.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.id,id),eq(mcpOauthGrants.userId,userId)));
      if(!candidate)return;
      const grant=await revokeGrantTransaction(candidate,async tx=>{
        const [revoked]=await tx.update(mcpOauthGrants).set({revokedAt:new Date()}).where(and(eq(mcpOauthGrants.id,id),eq(mcpOauthGrants.userId,userId),isNull(mcpOauthGrants.revokedAt))).returning();return revoked;
      });
      await fenceAgentGrant(grant);
      if(grant)await logActivity(db,{companyId:grant.companyId,actorType:"user",actorId:userId,action:"mcp.connection_revoked",entityType:"mcp_connection",entityId:grant.id,details:{clientId:grant.clientId}});
    },
  };
}
export type PublicMcpOAuth = ReturnType<typeof createPublicMcpOAuth>;

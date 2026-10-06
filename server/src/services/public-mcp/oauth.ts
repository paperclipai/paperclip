import { instanceSettingsService } from "../instance-settings.js";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, lte, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { Request } from "express";
import {
  type Db, activityLog, companies, companyLogos, mcpOauthClients, mcpOauthGrants, mcpOauthRequests, mcpOauthTokens, mcpOauthDeviceRequests, mcpOauthMetadataAdmissions,
} from "@paperclipai/db";
import { PUBLIC_MCP_PATH, PUBLIC_MCP_SCOPES, type McpConnectionRequest } from "@paperclipai/shared";
import { boardAuthService } from "../board-auth.js";
import { logActivity } from "../activity-log.js";
import { createClientMetadataResolver, mcpRedirectMatches, validMcpRedirect as validRedirect, type MetadataFetch } from "./client-metadata.js";

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
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Public MCP requires PAPERCLIP_PUBLIC_URL to be an HTTPS origin (HTTP loopback is allowed for development).");
  }
  return { origin: url.origin, resource: url.origin + PUBLIC_MCP_PATH };
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

export function createPublicMcpOAuth(db: Db, config: PublicMcpConfig, options: { metadataFetch?: MetadataFetch } = {}) {
  const resolveMetadata = createClientMetadataResolver(options.metadataFetch);
  const settings = instanceSettingsService(db);
  const isEnabled = async () => (await settings.getExperimental()).enablePublicMcp === true;
  async function assertEnabled() {
    if (!await isEnabled()) throw new PublicMcpDisabledError();
  }
  const boardAuth = boardAuthService(db);

  async function actorForGrant(grant: typeof mcpOauthGrants.$inferSelect): Promise<Request["actor"]> {
    if (grant.revokedAt || grant.resource !== config.resource) throw invalidGrant();
    const access = await boardAuth.resolveBoardAccess(grant.userId);
    const membership = access.memberships.find((m) => m.companyId === grant.companyId && m.status === "active");
    const [company] = await db.select({ status: companies.status }).from(companies).where(eq(companies.id, grant.companyId));
    if (!access.user || !membership || !company || company.status === "archived") throw invalidGrant();
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
      ...(refresh ? [{ grantId: grant.id, tokenHash: hashMcpSecret(refresh), kind: "refresh" as const, expiresAt: new Date(Date.now() + refreshLifetime) }] : []),
    ]);
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

  async function approveGrant(tx: Db, actor: Request["actor"], request: { requestedCompanyId: string | null; clientId: string; resource: string; scopes: string[] }, input: { companyId?: string; allowWrites: boolean }) {
    if (actor.type !== "board" || !actor.userId || !["session", "cloud_tenant"].includes(actor.source ?? "")) throw new McpOAuthError("access_denied", "Sign in to approve an assistant connection.", 401);
    const access = await boardAuth.resolveBoardAccess(actor.userId);
    const membership = access.memberships.find(m => m.companyId === input.companyId && m.status === "active");
    if (!access.user || !membership || (request.requestedCompanyId && request.requestedCompanyId !== input.companyId)) throw new McpOAuthError("access_denied", "Choose an available organization for this request.", 403);
    const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, input.companyId!));
    if (!company || company.status === "archived") throw new McpOAuthError("access_denied", "This organization is no longer available.", 403);
    if (input.allowWrites && membership.membershipRole === "viewer") throw new McpOAuthError("access_denied", "Viewer access is read-only.", 403);
    const scopes = request.scopes.filter(s => s !== "paperclip:write" || input.allowWrites);
    const [grant] = await tx.insert(mcpOauthGrants).values({ companyId: input.companyId!, userId: actor.userId, clientId: request.clientId, resource: request.resource, scopes }).returning();
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
      await actorForGrant(grant);
      await tx.update(mcpOauthDeviceRequests).set({ status: "consumed" }).where(eq(mcpOauthDeviceRequests.id, row.id));
      return { tokens: await issueTokens(tx as unknown as Db, grant) };
    });
    if (outcome.error) throw new McpOAuthError(outcome.error, "Device authorization is pending, denied, expired, or polling too quickly. Follow the returned OAuth error.");
    return outcome.tokens!;
  }

  return {
    config, isEnabled, assertEnabled,
    async deviceAuthorize(input: unknown, source = "unknown") {
      await assertEnabled();
      const p = z.object({ client_id: z.string().min(1).max(2048), resource: z.literal(config.resource), scope: z.string().max(200).default("paperclip:read"), company_id: z.uuid().optional() }).safeParse(input);
      if (!p.success) throw new McpOAuthError("invalid_request", "Supply a registered client and the exact Paperclip resource.");
      const scopes = [...new Set(p.data.scope.split(/\s+/).filter(Boolean))];
      if (!scopes.includes("paperclip:read") || scopes.some(s => !(PUBLIC_MCP_SCOPES as readonly string[]).includes(s))) throw new McpOAuthError("invalid_scope", "Unsupported Paperclip scope.");
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
      return { device_code: deviceCode, user_code: userCode, verification_uri: config.origin + "/mcp-device", verification_uri_complete: config.origin + "/mcp-device?user_code=" + userCode, expires_in: 600, interval: 5 };
    },
    async describeDevice(userCode: string, actor: Request["actor"]): Promise<McpConnectionRequest> {
      await assertEnabled();
      const [row] = await db.select({ request: mcpOauthDeviceRequests, client: mcpOauthClients }).from(mcpOauthDeviceRequests)
        .innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthDeviceRequests.clientId))
        .where(and(eq(mcpOauthDeviceRequests.userCodeHash, deviceHash(userCode)), eq(mcpOauthDeviceRequests.status, "pending"), gt(mcpOauthDeviceRequests.expiresAt, new Date())));
      if (!row) throw new McpOAuthError("invalid_request", "This code is expired, already decided, or invalid. Start a new connection from your assistant.", 404);
      return { id: row.request.id, clientName: row.client.name, redirectOrigin: "", clientOrigin: row.client.id.startsWith("https://") ? new URL(row.client.id).origin : null,
        requestedWrite: row.request.scopes.includes("paperclip:write"), offlineAccess: row.request.scopes.includes("offline_access"), requestedCompanyId: row.request.requestedCompanyId,
        setupUrl: null, ...await consentContext(actor, row.request.requestedCompanyId) };
    },
    async consentDevice(userCode: string, actor: Request["actor"], input: { decision: "approve" | "deny"; companyId?: string; allowWrites: boolean }) {
      await assertEnabled();
      if (actor.type !== "board" || !actor.userId || !["session", "cloud_tenant"].includes(actor.source ?? "")) throw new McpOAuthError("access_denied", "Sign in to approve a connection.", 401);
      return db.transaction(async tx => {
        const [row] = await tx.select().from(mcpOauthDeviceRequests).where(eq(mcpOauthDeviceRequests.userCodeHash, deviceHash(userCode))).for("update");
        if (!row || row.status !== "pending" || row.expiresAt <= new Date()) throw invalidGrant();
        const grant = input.decision === "approve" ? await approveGrant(tx as unknown as Db, actor, row, input) : null;
        await tx.update(mcpOauthDeviceRequests).set({ status: grant ? "approved" : "denied", grantId: grant?.id ?? null }).where(eq(mcpOauthDeviceRequests.id, row.id));
        return { status: grant ? "approved" as const : "denied" as const };
      });
    },
    async register(input: unknown, source = "unknown") {
      await assertEnabled();
      const parsed = registrationSchema.safeParse(input);
      if (!parsed.success) throw new McpOAuthError("invalid_client_metadata", "Supply a client name, valid redirect URIs, and public-client PKCE authentication.");
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
      const parsed = authorizeSchema.safeParse(input);
      if (!parsed.success) throw new McpOAuthError("invalid_request", "A registered client, exact redirect URI, resource, and S256 PKCE challenge are required.");
      const p = parsed.data;
      if (p.resource !== config.resource) throw new McpOAuthError("invalid_target", "Resource does not match this Paperclip MCP endpoint.");
      const scopes = [...new Set(p.scope.split(/\s+/).filter(Boolean))];
      if (!scopes.includes("paperclip:read") || scopes.some((s) => !(PUBLIC_MCP_SCOPES as readonly string[]).includes(s))) {
        throw new McpOAuthError("invalid_scope", "Unsupported Paperclip scope.");
      }
      const client = await resolveClient(p.client_id, source);
      if (!client || !client.grantTypes.includes("authorization_code") || !mcpRedirectMatches(client.redirectUris, p.redirect_uri, client.native)) {
        throw new McpOAuthError("invalid_request", "Unknown client or redirect URI.");
      }
      const id = secret("pcmcp_request_");
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
      return config.origin + "/mcp-connect/" + id;
    },
    async describeRequest(id: string, actor: Request["actor"], setupUrl: string | null): Promise<McpConnectionRequest> {
      await assertEnabled();
      const [row] = await db.select({ request: mcpOauthRequests, client: mcpOauthClients })
        .from(mcpOauthRequests).innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthRequests.clientId))
        .where(and(eq(mcpOauthRequests.id, id), isNull(mcpOauthRequests.decidedAt), gt(mcpOauthRequests.expiresAt, new Date())));
      if (!row) throw new McpOAuthError("invalid_request", "Connection request is expired or already decided.", 404);
      return {
        id, clientName: row.client.name, redirectOrigin: new URL(row.request.redirectUri).origin,
        clientOrigin: row.client.id.startsWith("https://") ? new URL(row.client.id).origin : null,
        requestedWrite: row.request.scopes.includes("paperclip:write"), offlineAccess: row.request.scopes.includes("offline_access"),
        requestedCompanyId: row.request.requestedCompanyId,
        ...await consentContext(actor, row.request.requestedCompanyId), setupUrl,
      };
    },
    async consent(id: string, actor: Request["actor"], input: { decision: "approve" | "deny"; companyId?: string; allowWrites: boolean }) {
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
        if (!row || row.decidedAt || row.expiresAt <= new Date()) throw invalidGrant();
        const redirect = new URL(row.redirectUri);
        redirect.searchParams.set("iss", config.origin);
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
    async token(input: Record<string, unknown>) {
      await assertEnabled();
      const clientId = typeof input.client_id === "string" ? input.client_id : "";
      if (!clientId || input.resource !== config.resource) throw new McpOAuthError("invalid_target", "Client and matching resource are required.");
      if (input.grant_type === DEVICE_GRANT) return deviceToken(input, clientId);
      if (input.grant_type === "authorization_code") {
        if (typeof input.code !== "string" || typeof input.code_verifier !== "string"
          || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)) throw invalidGrant();
        const codeHash = hashMcpSecret(input.code);
        const challenge = createHash("sha256").update(input.code_verifier).digest("base64url");
        return db.transaction(async (tx) => {
          const [row] = await tx.select().from(mcpOauthRequests).where(eq(mcpOauthRequests.codeHash, codeHash)).for("update");
          if (!row || row.clientId !== clientId || row.redirectUri !== input.redirect_uri
            || row.resource !== config.resource || row.challenge !== challenge || row.consumedAt
            || row.expiresAt <= new Date() || !row.grantId) throw invalidGrant();
          const [grant] = await tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, row.grantId)).for("update");
          if (!grant) throw invalidGrant();
          await actorForGrant(grant);
          await tx.update(mcpOauthRequests).set({ consumedAt: new Date() }).where(eq(mcpOauthRequests.id, row.id));
          return issueTokens(tx as unknown as Db, grant);
        });
      }
      if (input.grant_type === "refresh_token") {
        if (typeof input.refresh_token !== "string") throw invalidGrant();
        const tokenHash = hashMcpSecret(input.refresh_token);
        // A replay revokes the whole grant. Commit that revocation before returning an error.
        const result = await db.transaction(async (tx) => {
          const [token] = await tx.select().from(mcpOauthTokens).where(eq(mcpOauthTokens.tokenHash, tokenHash)).for("update");
          if (!token || token.kind !== "refresh") return null;
          const [grant] = await tx.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, token.grantId)).for("update");
          if (!grant || grant.clientId !== clientId || grant.resource !== config.resource || grant.revokedAt) return null;
          if (token.usedAt) {
            await tx.update(mcpOauthGrants).set({ revokedAt: new Date() }).where(eq(mcpOauthGrants.id, grant.id));
            await tx.insert(activityLog).values({
              companyId: grant.companyId, actorType: "system", actorId: "mcp_oauth",
              action: "mcp.connection_revoked", entityType: "mcp_connection", entityId: grant.id,
              details: { clientId: grant.clientId, reason: "refresh_token_replay" },
            });
            return null;
          }
          if (token.expiresAt <= new Date()) return null;
          await actorForGrant(grant);
          if (input.scope !== undefined && input.scope !== grant.scopes.join(" ")) {
            throw new McpOAuthError("invalid_scope", "Refresh cannot change the consented scopes; reconnect instead.");
          }
          await tx.update(mcpOauthTokens).set({ usedAt: new Date() }).where(eq(mcpOauthTokens.id, token.id));
          return issueTokens(tx as unknown as Db, grant);
        });
        if (!result) throw invalidGrant();
        return result;
      }
      throw new McpOAuthError("unsupported_grant_type", "Unsupported authorization grant.");
    },
    async authorizeGrant(grantId: string): Promise<McpPrincipal> {
      await assertEnabled();
      const [row] = await db.select({ grant: mcpOauthGrants, company: { id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix, status: companies.status } })
        .from(mcpOauthGrants).innerJoin(companies, eq(mcpOauthGrants.companyId, companies.id))
        .where(eq(mcpOauthGrants.id, grantId));
      if (!row || !row.grant.scopes.includes("paperclip:read")) throw invalidGrant();
      return { ...row, actor: await actorForGrant(row.grant) };
    },
    async authenticate(token: string): Promise<McpPrincipal> {
      await assertEnabled();
      const [row] = await db.select({ token: mcpOauthTokens, grant: mcpOauthGrants, company: { id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix, status: companies.status } })
        .from(mcpOauthTokens).innerJoin(mcpOauthGrants, eq(mcpOauthTokens.grantId, mcpOauthGrants.id))
        .innerJoin(companies, eq(companies.id, mcpOauthGrants.companyId))
        .where(and(eq(mcpOauthTokens.tokenHash, hashMcpSecret(token)), eq(mcpOauthTokens.kind, "access"),
          gt(mcpOauthTokens.expiresAt, new Date()), isNull(mcpOauthGrants.revokedAt)));
      if (!row) throw new McpOAuthError("invalid_token", "Connect Paperclip again.", 401);
      try { return { grant: row.grant, company: row.company, actor: await actorForGrant(row.grant) }; }
      catch { throw new McpOAuthError("invalid_token", "Paperclip access is no longer available.", 401); }
    },
    async revokeToken(token: string, clientId: string) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select({ grant: mcpOauthGrants }).from(mcpOauthTokens)
          .innerJoin(mcpOauthGrants, eq(mcpOauthTokens.grantId, mcpOauthGrants.id))
          .where(and(eq(mcpOauthTokens.tokenHash, hashMcpSecret(token)), eq(mcpOauthGrants.clientId, clientId)));
        if (!row) return;
        const [revoked] = await tx.update(mcpOauthGrants).set({ revokedAt: new Date() })
          .where(and(eq(mcpOauthGrants.id, row.grant.id), isNull(mcpOauthGrants.revokedAt))).returning();
        if (revoked) await tx.insert(activityLog).values({
          companyId: revoked.companyId, actorType: "user", actorId: revoked.userId,
          action: "mcp.connection_revoked", entityType: "mcp_connection", entityId: revoked.id,
          details: { clientId, reason: "oauth_revocation" },
        });
      });
    },
    async listConnections(userId: string) {
      const rows = await db.select({ grant: mcpOauthGrants, clientName: mcpOauthClients.name, companyName: companies.name })
        .from(mcpOauthGrants).innerJoin(mcpOauthClients, eq(mcpOauthGrants.clientId, mcpOauthClients.id))
        .innerJoin(companies, eq(companies.id, mcpOauthGrants.companyId))
        .where(eq(mcpOauthGrants.userId, userId));
      return rows.map(({ grant, clientName, companyName }) => ({
        id: grant.id, companyId: grant.companyId, clientName, companyName, scopes: grant.scopes,
        createdAt: grant.createdAt.toISOString(), revokedAt: grant.revokedAt?.toISOString() ?? null,
      }));
    },
    async revokeConnection(id: string, userId: string) {
      const [grant] = await db.update(mcpOauthGrants).set({ revokedAt: new Date() })
        .where(and(eq(mcpOauthGrants.id, id), eq(mcpOauthGrants.userId, userId), isNull(mcpOauthGrants.revokedAt))).returning();
      if (grant) await logActivity(db, {
        companyId: grant.companyId, actorType: "user", actorId: userId, action: "mcp.connection_revoked",
        entityType: "mcp_connection", entityId: grant.id, details: { clientId: grant.clientId },
      });
    },
  };
}
export type PublicMcpOAuth = ReturnType<typeof createPublicMcpOAuth>;

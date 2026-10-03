import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { Request } from "express";
import {
  type Db, activityLog, companies, mcpOauthClients, mcpOauthGrants, mcpOauthRequests, mcpOauthTokens,
} from "@paperclipai/db";
import { PUBLIC_MCP_PATH, PUBLIC_MCP_SCOPES, type McpConnectionRequest } from "@paperclipai/shared";
import { boardAuthService } from "../board-auth.js";
import { logActivity } from "../activity-log.js";

const minute = 60_000;
const accessLifetime = 15 * minute;
const refreshLifetime = 30 * 24 * 60 * minute;
export const hashMcpSecret = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = (prefix: string) => prefix + randomBytes(32).toString("base64url");

export class McpOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const invalidGrant = () => new McpOAuthError("invalid_grant", "Authorization is expired, revoked, or invalid.");

export function publicMcpConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.PAPERCLIP_PUBLIC_MCP_ENABLED !== "true") return null;
  if (!env.PAPERCLIP_PUBLIC_URL) throw new Error("PAPERCLIP_PUBLIC_URL is required when public MCP is enabled.");
  const url = new URL(env.PAPERCLIP_PUBLIC_URL);
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

function validRedirect(value: string) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash
      && (url.protocol === "https:" || (url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

const registrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(z.string().max(2048).refine(validRedirect)).min(1).max(10),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.literal("code")).default(["code"]),
}).strip();

const authorizeSchema = z.object({
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().max(2048),
  response_type: z.literal("code"),
  resource: z.string().max(2048),
  scope: z.string().max(200).default("paperclip:read"),
  state: z.string().max(2048).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
}).strip();

export function createPublicMcpOAuth(db: Db, config: PublicMcpConfig) {
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

  return {
    config,
    async register(input: unknown, source = "unknown") {
      const parsed = registrationSchema.safeParse(input);
      if (!parsed.success) throw new McpOAuthError("invalid_client_metadata", "Supply a client name, valid redirect URIs, and public-client PKCE authentication.");
      const client = { id: secret("pcmcp_client_"), name: parsed.data.client_name, registrationSourceHash: hashMcpSecret(config.resource + ":" + source), redirectUris: parsed.data.redirect_uris };
      await db.transaction(async (tx) => {
        // Bound public DCR across replicas, not only per-IP in each process.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(736721042)`);
        const now = new Date();
        await tx.delete(mcpOauthRequests).where(lt(mcpOauthRequests.expiresAt, now));
        await tx.delete(mcpOauthClients).where(and(
          lt(mcpOauthClients.createdAt, new Date(now.getTime() - 60 * minute)),
          notExists(tx.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId, mcpOauthClients.id))),
          notExists(tx.select({ id: mcpOauthRequests.id }).from(mcpOauthRequests).where(eq(mcpOauthRequests.clientId, mcpOauthClients.id))),
        ));
        const [counts] = await tx.select({ total: sql<number>`count(*)::int`,
          sourceTotal: sql<number>`(count(*) FILTER (WHERE ${mcpOauthClients.registrationSourceHash} = ${client.registrationSourceHash}))::int`,
          sourceRecent: sql<number>`(count(*) FILTER (WHERE ${mcpOauthClients.registrationSourceHash} = ${client.registrationSourceHash} AND ${mcpOauthClients.createdAt} > ${new Date(now.getTime() - minute).toISOString()}::timestamptz))::int`,
          recent: sql<number>`(count(*) FILTER (WHERE ${mcpOauthClients.createdAt} > ${new Date(now.getTime() - minute).toISOString()}::timestamptz))::int`,
        }).from(mcpOauthClients).where(notExists(tx.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId, mcpOauthClients.id))));
        if (!counts || counts.total >= 10_000 || counts.recent >= 60 || counts.sourceTotal >= 30 || counts.sourceRecent >= 6) {
          throw new McpOAuthError("temporarily_unavailable", "Registration capacity reached. Retry later.", 429);
        }
        await tx.insert(mcpOauthClients).values(client);
      });
      return { ...parsed.data, client_id: client.id, client_id_issued_at: Math.floor(Date.now() / 1000) };
    },
    async authorize(input: unknown) {
      const parsed = authorizeSchema.safeParse(input);
      if (!parsed.success) throw new McpOAuthError("invalid_request", "A registered client, exact redirect URI, resource, and S256 PKCE challenge are required.");
      const p = parsed.data;
      const [client] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.id, p.client_id));
      if (!client || !client.redirectUris.includes(p.redirect_uri)) {
        throw new McpOAuthError("invalid_request", "Unknown client or redirect URI.");
      }
      if (p.resource !== config.resource) throw new McpOAuthError("invalid_target", "Resource does not match this Paperclip MCP endpoint.");
      const scopes = [...new Set(p.scope.split(/\s+/).filter(Boolean))];
      if (!scopes.includes("paperclip:read") || scopes.some((s) => !(PUBLIC_MCP_SCOPES as readonly string[]).includes(s))) {
        throw new McpOAuthError("invalid_scope", "Unsupported Paperclip scope.");
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
        await tx.insert(mcpOauthRequests).values({
          id, clientId: client.id, redirectUri: p.redirect_uri, resource: p.resource, scopes,
          state: p.state ?? null, challenge: p.code_challenge, expiresAt: new Date(now.getTime() + 10 * minute),
        });
      });
      return config.origin + "/mcp-connect/" + id;
    },
    async describeRequest(id: string, actor: Request["actor"], setupUrl: string | null): Promise<McpConnectionRequest> {
      const [row] = await db.select({ request: mcpOauthRequests, client: mcpOauthClients })
        .from(mcpOauthRequests).innerJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthRequests.clientId))
        .where(and(eq(mcpOauthRequests.id, id), isNull(mcpOauthRequests.decidedAt), gt(mcpOauthRequests.expiresAt, new Date())));
      if (!row) throw new McpOAuthError("invalid_request", "Connection request is expired or already decided.", 404);
      const signedIn = actor.type === "board" && !!actor.userId && ["session", "cloud_tenant"].includes(actor.source ?? "");
      const access = signedIn ? await boardAuth.resolveBoardAccess(actor.userId!) : null;
      const available = access?.user && access.companyIds.length ? await db.select({ id: companies.id, name: companies.name, status: companies.status })
        .from(companies).where(inArray(companies.id, access.companyIds)) : [];
      return {
        id, clientName: row.client.name, redirectOrigin: new URL(row.request.redirectUri).origin,
        requestedWrite: row.request.scopes.includes("paperclip:write"), offlineAccess: row.request.scopes.includes("offline_access"), requiresSignIn: !access?.user,
        companies: available.flatMap((company) => {
          const membership = access?.memberships.find((m) => m.companyId === company.id);
          return membership?.status === "active" && company.status !== "archived"
            ? [{ id: company.id, name: company.name, canWrite: membership.membershipRole !== "viewer" }] : [];
        }), setupUrl,
      };
    },
    async consent(id: string, actor: Request["actor"], input: { decision: "approve" | "deny"; companyId?: string; allowWrites: boolean }) {
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
        if (row.state !== null) redirect.searchParams.set("state", row.state);
        if (input.decision === "deny") {
          await tx.update(mcpOauthRequests).set({ decidedAt: new Date() }).where(eq(mcpOauthRequests.id, id));
          redirect.searchParams.set("error", "access_denied");
          return { redirectUrl: redirect.toString(), grant: null };
        }
        const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, input.companyId!));
        if (!company || company.status === "archived") throw new McpOAuthError("access_denied", "This company is no longer available.", 403);
        if (input.allowWrites && membership?.membershipRole === "viewer") throw new McpOAuthError("access_denied", "Viewer access is read-only.", 403);
        const scopes = row.scopes.filter((s) => s !== "paperclip:write" || input.allowWrites);
        const [grant] = await tx.insert(mcpOauthGrants).values({
          companyId: input.companyId!, userId: actor.userId!, clientId: row.clientId, resource: row.resource, scopes,
        }).returning();
        const code = secret("pcmcp_code_");
        await tx.update(mcpOauthRequests).set({
          grantId: grant!.id, codeHash: hashMcpSecret(code), decidedAt: new Date(), expiresAt: new Date(Date.now() + minute),
        }).where(eq(mcpOauthRequests.id, id));
        redirect.searchParams.set("code", code);
        await tx.insert(activityLog).values({
          companyId: grant!.companyId, actorType: "user", actorId: actor.userId!,
          action: "mcp.connection_authorized", entityType: "mcp_connection", entityId: grant!.id,
          details: { clientId: grant!.clientId, scopes },
        });
        return { redirectUrl: redirect.toString(), grant };
      });
      return { redirectUrl: result.redirectUrl };
    },
    async token(input: Record<string, unknown>) {
      const clientId = typeof input.client_id === "string" ? input.client_id : "";
      if (!clientId || input.resource !== config.resource) throw new McpOAuthError("invalid_target", "Client and matching resource are required.");
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
      throw new McpOAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
    },
    async authorizeGrant(grantId: string): Promise<McpPrincipal> {
      const [row] = await db.select({ grant: mcpOauthGrants, company: { id: companies.id, name: companies.name, issuePrefix: companies.issuePrefix, status: companies.status } })
        .from(mcpOauthGrants).innerJoin(companies, eq(mcpOauthGrants.companyId, companies.id))
        .where(eq(mcpOauthGrants.id, grantId));
      if (!row || !row.grant.scopes.includes("paperclip:read")) throw invalidGrant();
      return { ...row, actor: await actorForGrant(row.grant) };
    },
    async authenticate(token: string): Promise<McpPrincipal> {
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

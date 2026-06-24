import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { cloudflareConnections } from "@paperclipai/db";
import type { CloudflareConnection, CloudflareZone } from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const CF_API = "https://api.cloudflare.com/client/v4";

/** Name of the company_secret that holds a connection's Cloudflare API token. */
const CF_TOKEN_SECRET_NAME = "CLOUDFLARE_API_TOKEN";

export type CloudflareActor = { actorType: "user" | "agent"; actorId: string };

export interface CloudflareDnsRecord {
  type: "A" | "MX" | "TXT" | "CNAME";
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

type ConnectionRow = typeof cloudflareConnections.$inferSelect;

function toConnection(row: ConnectionRow): CloudflareConnection {
  return {
    id: row.id,
    companyId: row.companyId,
    cfAccountId: row.cfAccountId,
    status: row.status as CloudflareConnection["status"],
    scopes: row.scopes ?? [],
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Minimal typed wrapper over the Cloudflare v4 REST API envelope. */
async function cfFetch<T = unknown>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${CF_API}${path}`);
  for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    // Don't let a hung Cloudflare request stall a request handler indefinitely.
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw unprocessable(`Cloudflare: ${err instanceof Error ? err.message : "request failed"}`);
  });
  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: T; errors?: Array<{ message?: string }> }
    | null;
  if (!res.ok || !json?.success) {
    const message =
      json?.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
      `Cloudflare API error (${res.status})`;
    throw unprocessable(`Cloudflare: ${message}`);
  }
  return json.result as T;
}

export function cloudflareService(db: Db) {
  const secrets = secretService(db);

  async function getRow(companyId: string): Promise<ConnectionRow | null> {
    return db
      .select()
      .from(cloudflareConnections)
      .where(eq(cloudflareConnections.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  /** Resolve the plaintext API token for a company's connection. */
  async function getToken(companyId: string): Promise<string> {
    const row = await getRow(companyId);
    if (!row) throw notFound("No Cloudflare connection for this company");
    const resolved = await secrets.resolveEnvBindings(companyId, {
      [CF_TOKEN_SECRET_NAME]: { type: "secret_ref", secretId: row.apiTokenSecretId, version: "latest" },
    });
    const token = resolved.env[CF_TOKEN_SECRET_NAME];
    if (!token) throw unprocessable("Cloudflare token could not be resolved");
    return token;
  }

  return {
    get: async (companyId: string): Promise<CloudflareConnection | null> => {
      const row = await getRow(companyId);
      return row ? toConnection(row) : null;
    },

    getToken,

    /**
     * Connect (or replace) a company's Cloudflare account. The token is verified
     * against the Cloudflare API, stored as a company secret, and the connection
     * row is upserted. The raw token never persists on the connection row.
     */
    connect: async (
      companyId: string,
      input: { apiToken: string; cfAccountId?: string },
      actor: CloudflareActor,
    ): Promise<CloudflareConnection> => {
      const actorRef = {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.actorType === "agent" ? actor.actorId : null,
      };

      // 1. Verify the token works before storing anything.
      const verify = await cfFetch<{ id: string; status: string }>(input.apiToken, "/user/tokens/verify");
      if (verify.status !== "active") {
        throw unprocessable(`Cloudflare token is not active (status: ${verify.status})`);
      }

      // 2. Resolve an account id if not supplied.
      let accountId = input.cfAccountId ?? null;
      if (!accountId) {
        const accounts = await cfFetch<Array<{ id: string; name: string }>>(input.apiToken, "/accounts", {
          query: { "per_page": "1" },
        });
        accountId = accounts[0]?.id ?? null;
      }

      // 3. Store the token as a company secret (create or rotate).
      const existingSecret = await secrets.getByName(companyId, CF_TOKEN_SECRET_NAME);
      let secretId: string;
      if (existingSecret) {
        await secrets.rotate(existingSecret.id, { value: input.apiToken }, actorRef);
        secretId = existingSecret.id;
      } else {
        const created = await secrets.create(
          companyId,
          { name: CF_TOKEN_SECRET_NAME, provider: "local_encrypted", value: input.apiToken },
          actorRef,
        );
        secretId = created.id;
      }

      // 4. Upsert the connection row.
      const now = new Date();
      const existing = await getRow(companyId);
      let row: ConnectionRow;
      if (existing) {
        row = await db
          .update(cloudflareConnections)
          .set({
            cfAccountId: accountId,
            apiTokenSecretId: secretId,
            status: "active",
            verifiedAt: now,
            updatedAt: now,
          })
          .where(eq(cloudflareConnections.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      } else {
        row = await db
          .insert(cloudflareConnections)
          .values({
            companyId,
            cfAccountId: accountId,
            apiTokenSecretId: secretId,
            status: "active",
            verifiedAt: now,
            createdByAgentId: actorRef.agentId,
            createdByUserId: actorRef.userId,
          })
          .returning()
          .then((rows) => rows[0]);
      }
      return toConnection(row);
    },

    disconnect: async (companyId: string): Promise<void> => {
      const row = await getRow(companyId);
      if (!row) return;
      await db.delete(cloudflareConnections).where(eq(cloudflareConnections.id, row.id));
      // Best-effort cleanup of the stored token secret so it doesn't linger.
      await secrets.remove(row.apiTokenSecretId).catch(() => {});
    },

    /** List the zones (domains) the connected account can manage (all pages). */
    listZones: async (companyId: string): Promise<CloudflareZone[]> => {
      const token = await getToken(companyId);
      const perPage = 50;
      const out: CloudflareZone[] = [];
      for (let page = 1; page <= 20; page++) {
        const zones = await cfFetch<Array<{ id: string; name: string; status: string }>>(token, "/zones", {
          query: { per_page: String(perPage), page: String(page) },
        });
        out.push(...zones.map((z) => ({ id: z.id, name: z.name, status: z.status })));
        if (zones.length < perPage) break;
      }
      return out;
    },

    /** Resolve a zone id for a domain name owned by the connected account. */
    getZoneId: async (companyId: string, domain: string): Promise<string> => {
      const token = await getToken(companyId);
      const zones = await cfFetch<Array<{ id: string; name: string }>>(token, "/zones", {
        query: { name: domain },
      });
      const zone = zones[0];
      if (!zone) throw badRequest(`Domain "${domain}" is not a zone in the connected Cloudflare account`);
      return zone.id;
    },

    /**
     * Create or update a single DNS record (idempotent on type+name). Used to
     * publish the mail records (MX/SPF/DKIM/DMARC) on an attached zone.
     */
    upsertDnsRecord: async (
      companyId: string,
      zoneId: string,
      record: CloudflareDnsRecord,
    ): Promise<void> => {
      const token = await getToken(companyId);
      const existing = await cfFetch<Array<{ id: string }>>(token, `/zones/${zoneId}/dns_records`, {
        query: { type: record.type, name: record.name },
      });
      const body: Record<string, unknown> = {
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl ?? 1,
      };
      if (record.priority !== undefined) body.priority = record.priority;
      if (existing[0]) {
        await cfFetch(token, `/zones/${zoneId}/dns_records/${existing[0].id}`, { method: "PUT", body });
      } else {
        await cfFetch(token, `/zones/${zoneId}/dns_records`, { method: "POST", body });
      }
    },

    /**
     * Delete DNS records matching a type + name (optionally only those whose
     * content contains a marker, e.g. our SPF record on a shared apex TXT). Used
     * to clean up the mail records when a domain is detached.
     */
    deleteDnsRecords: async (
      companyId: string,
      zoneId: string,
      match: { type: string; name: string; contentIncludes?: string },
    ): Promise<void> => {
      const token = await getToken(companyId);
      const existing = await cfFetch<Array<{ id: string; content: string }>>(
        token,
        `/zones/${zoneId}/dns_records`,
        { query: { type: match.type, name: match.name } },
      );
      for (const rec of existing) {
        if (match.contentIncludes && !(rec.content ?? "").includes(match.contentIncludes)) continue;
        await cfFetch(token, `/zones/${zoneId}/dns_records/${rec.id}`, { method: "DELETE" });
      }
    },
  };
}

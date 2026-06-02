/**
 * Google OAuth 2.0 helpers for GSC (Search Console) API.
 *
 * Ported from the AGNB app's lib/agnb/google-oauth.ts. The original read OAuth
 * tokens from Supabase's `internal.oauth_tokens` via a service client; here we
 * read/write `agnb.oauth_tokens` through the scheduler's drizzle `db`.
 *
 * Tokens are seeded out-of-band (the original app's OAuth consent flow writes
 * the row). This module only refreshes + uses them:
 *   getValidGoogleAccessToken(db) — reads row, refreshes if expired, persists.
 *
 * Requires env GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET to refresh.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rows } from "../helpers.js";

export const GSC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`google refresh http ${r.status}: ${t.slice(0, 300)}`);
  }
  return (await r.json()) as TokenResponse;
}

interface OAuthTokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

/**
 * Get a usable access token. Reads from agnb.oauth_tokens, refreshes if expired,
 * persists. Returns null if no token row exists (operator hasn't connected GSC).
 */
export async function getValidGoogleAccessToken(db: Db): Promise<string | null> {
  const tokenRows = rows<OAuthTokenRow>(
    await db.execute(sql`
      SELECT access_token, refresh_token, expires_at
      FROM agnb.oauth_tokens
      WHERE provider = 'google'
      LIMIT 1
    `),
  );
  const row = tokenRows[0];
  if (!row) return null;

  // 60s buffer
  if (new Date(row.expires_at).getTime() - 60_000 > Date.now()) {
    return row.access_token;
  }

  // Refresh
  const fresh = await refreshAccessToken(row.refresh_token);
  const newExpiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
  const newRefresh = fresh.refresh_token ?? row.refresh_token;
  await db.execute(sql`
    UPDATE agnb.oauth_tokens
    SET access_token = ${fresh.access_token},
        expires_at = ${newExpiresAt},
        refresh_token = ${newRefresh},
        updated_at = now()
    WHERE provider = 'google'
  `);
  return fresh.access_token;
}

export interface GscQueryRow {
  keys: string[]; // [page, query] when dimensions=['page','query']
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Query GSC API. Defaults: dimensions page+query, rowLimit 5000.
 * Requires a connected Google token in agnb.oauth_tokens.
 */
export async function gscQuery(
  db: Db,
  opts: {
    propertyUrl: string; // e.g. "sc-domain:hirefinn.ai"
    startDate: string; // YYYY-MM-DD
    endDate: string;
    dimensions?: string[]; // default ['page','query']
    rowLimit?: number; // max 25_000
  },
): Promise<GscQueryRow[]> {
  const token = await getValidGoogleAccessToken(db);
  if (!token) throw new Error("Google not connected — no agnb.oauth_tokens row for provider 'google'");

  const r = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(opts.propertyUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        startDate: opts.startDate,
        endDate: opts.endDate,
        dimensions: opts.dimensions ?? ["page", "query"],
        rowLimit: opts.rowLimit ?? 5_000,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`gsc query http ${r.status}: ${t.slice(0, 400)}`);
  }
  const j = (await r.json()) as { rows?: GscQueryRow[] };
  return j.rows ?? [];
}

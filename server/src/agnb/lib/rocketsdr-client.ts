import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * Rocket SDR MCP client — ported from agnb lib/rocketsdr/client.ts for
 * in-process use by the Paperclip AGNB scheduler.
 *
 * Wraps the JSON-RPC 2.0 endpoint at https://api.rocketsdr.ai/api/mcp.
 * Auth: `X-API-Key` header from process.env.ROCKETSDR_API_KEY.
 *
 * Endpoint override: ROCKET_MCP_URL or ROCKETSDR_MCP_URL (either accepted).
 * Optional bearer token (newer OAuth flow): ROCKET_MCP_TOKEN — sent as
 * `Authorization: Bearer <token>` alongside / instead of the API key.
 *
 * Differences from the Next.js original:
 *   - No `server-only`, no Supabase. Audit + quota writes go through the
 *     drizzle `Db` handle when one is passed in CallOpts (jobs pass ctx.db).
 *   - No Next data-cache. Jobs call upstream directly.
 *
 * Rate limits (per Rocket SDR docs): preview_leads 20/day, create_campaign
 * 10/day. We pre-flight check the local quota_log before spending budget.
 */

const DEFAULT_ENDPOINT = "https://api.rocketsdr.ai/api/mcp";

function resolveEndpoint(): string {
  return (
    process.env.ROCKET_MCP_URL ||
    process.env.ROCKETSDR_MCP_URL ||
    DEFAULT_ENDPOINT
  );
}

/** True when an API key (or bearer token) is configured. */
export function hasRocketKey(): boolean {
  return Boolean(process.env.ROCKETSDR_API_KEY || process.env.ROCKET_MCP_TOKEN);
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface JsonRpcResponse<T = JsonValue> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: JsonValue };
}

interface McpContent {
  content?: Array<{ type: string; text?: string }>;
}

function pluckText(result: McpContent | JsonValue | undefined): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const c = (result as McpContent).content;
  if (!Array.isArray(c)) return "";
  return c.map((b) => b.text ?? "").join("\n\n").trim();
}

/**
 * Parse `**ID: <id>** - <name>\n  <description>` blocks out of an MCP
 * markdown response. Tolerant — unknown lines are skipped.
 */
function parseIdNameDesc(markdown: string): Array<{
  id: string;
  name: string;
  description?: string;
}> {
  const lines = markdown.split("\n");
  const items: Array<{ id: string; name: string; description?: string }> = [];
  let current: { id: string; name: string; description?: string } | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const idMatch = line.match(/^[-*]\s*\*\*ID:\s*([\w-]+)\*\*\s*-\s*(.+)$/i);
    if (idMatch) {
      if (current) items.push(current);
      current = { id: idMatch[1], name: idMatch[2].trim() };
      continue;
    }
    if (current && !current.description) {
      const trimmed = line.trim();
      if (trimmed && !/^[-*#]/.test(trimmed)) {
        current.description = trimmed;
      }
    }
  }
  if (current) items.push(current);
  return items;
}

export interface CallOpts {
  /** Override env API key. */
  apiKey?: string;
  /** Bucket attribution — tagged on api_audit + quota_log rows. */
  bucketId?: string | null;
  /** drizzle handle for audit + quota writes; omit to skip auditing. */
  db?: Db;
}

/** Documented Rocket SDR daily caps (from /docs/mcp). */
export const ROCKETSDR_QUOTAS: Record<string, number> = {
  preview_leads: 20,
  create_campaign: 10,
  create_campaign_draft: 10,
  finalize_campaign_draft: 10,
};

/** Today's usage count for a method (UTC day boundary), via quota_log. */
async function getTodayUsage(db: Db, method: string): Promise<number> {
  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM agnb.quota_log
      WHERE method = ${method} AND called_at >= ${todayStart.toISOString()}
    `);
    const arr = Array.isArray(res) ? res : (res as { rows?: unknown[] })?.rows ?? [];
    const row = arr[0] as { n?: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Audit + quota log. Never throws — auditing must not break the call. */
async function logApiCall(
  db: Db | undefined,
  opts: {
    method: string;
    args?: Record<string, unknown>;
    ok: boolean;
    error?: string;
    duration_ms: number;
    caller?: string | null;
    bucket_id?: string | null;
  },
): Promise<void> {
  if (!db) return;
  try {
    await db.execute(sql`
      INSERT INTO agnb.api_audit (method, args, ok, error, duration_ms, caller, bucket_id)
      VALUES (
        ${opts.method},
        ${JSON.stringify(opts.args ?? {})}::jsonb,
        ${opts.ok},
        ${opts.error ?? null},
        ${opts.duration_ms},
        ${opts.caller ?? null},
        ${opts.bucket_id ?? null}
      )
    `);
    // Only successful calls count toward quota.
    if (opts.ok) {
      await db.execute(sql`
        INSERT INTO agnb.quota_log (method, caller, bucket_id)
        VALUES (${opts.method}, ${opts.caller ?? null}, ${opts.bucket_id ?? null})
      `);
    }
  } catch {
    // swallow — auditing must never break the actual API call
  }
}

let requestId = 0;

async function callTool<T = JsonValue>(
  method: string,
  args: Record<string, JsonValue> = {},
  opts: CallOpts = {},
): Promise<T> {
  const key = opts.apiKey ?? process.env.ROCKETSDR_API_KEY;
  const token = process.env.ROCKET_MCP_TOKEN;
  if (!key && !token) {
    throw new Error(
      "ROCKETSDR_API_KEY / ROCKET_MCP_TOKEN are not set. Cannot call Rocket SDR.",
    );
  }

  // Local pre-flight quota check so we fail fast instead of burning the
  // upstream cap. Skipped for read-only `list_*` calls (no published cap).
  const cap = ROCKETSDR_QUOTAS[method];
  if (cap !== undefined && opts.db) {
    const used = await getTodayUsage(opts.db, method);
    if (used >= cap) {
      const msg = `Rocket SDR daily quota for ${method} exhausted (${used}/${cap}). Resets at UTC 00:00.`;
      await logApiCall(opts.db, {
        method,
        args,
        ok: false,
        error: msg,
        duration_ms: 0,
        caller: null,
        bucket_id: opts.bucketId ?? null,
      });
      throw new Error(msg);
    }
  }

  requestId += 1;
  const body = {
    jsonrpc: "2.0" as const,
    id: requestId,
    method: "tools/call",
    params: { name: method, arguments: args },
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["X-API-Key"] = key;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const start = Date.now();
  let ok = false;
  let err: string | undefined;
  try {
    const res = await fetch(resolveEndpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      err = `Rocket SDR HTTP ${res.status}: ${await res.text()}`;
      throw new Error(err);
    }

    const json = (await res.json()) as JsonRpcResponse<T>;
    if (json.error) {
      err = `Rocket SDR RPC error ${json.error.code}: ${json.error.message}`;
      throw new Error(err);
    }
    if (json.result === undefined) {
      err = "Rocket SDR returned an empty result";
      throw new Error(err);
    }
    ok = true;
    return json.result;
  } catch (e) {
    if (!err) err = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    await logApiCall(opts.db, {
      method,
      args,
      ok,
      error: err,
      duration_ms: Date.now() - start,
      caller: null,
      bucket_id: opts.bucketId ?? null,
    });
  }
}

// ---- Read-only wrappers ----

export interface RocketSdrProduct {
  id: string;
  name: string;
  description?: string;
}

export interface RocketSdrPersona {
  id: string;
  name: string;
  title?: string;
}

export async function listProducts(
  opts?: CallOpts,
): Promise<{ products: RocketSdrProduct[]; raw: string }> {
  const result = await callTool<McpContent>("list_products", {}, opts);
  const raw = pluckText(result);
  const products = parseIdNameDesc(raw).map((it) => ({
    id: it.id,
    name: it.name,
    description: it.description,
  }));
  return { products, raw };
}

export async function listPersonas(
  opts?: CallOpts,
): Promise<{ personas: RocketSdrPersona[]; raw: string }> {
  const result = await callTool<McpContent>("list_personas", {}, opts);
  const raw = pluckText(result);
  const personas = parseIdNameDesc(raw).map((it) => ({
    id: it.id,
    name: it.name,
    title: it.description,
  }));
  return { personas, raw };
}

// ---- preview_leads (rate-limited 20/day) ----

export async function previewLeads(
  args: { persona_id?: string; targeting?: Record<string, JsonValue> },
  opts?: CallOpts,
): Promise<McpContent> {
  return callTool<McpContent>("preview_leads", { ...args }, opts);
}

// ---- Inbox reads ----

export interface RocketInboxThread {
  thread_id: string;
  lead_id?: string;
  lead_email?: string;
  lead_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  subject?: string;
  last_message_preview?: string;
  last_message_at?: string;
  intent_label?: string;
}

function parseInboxList(raw: string): RocketInboxThread[] {
  const blocks = raw.split(/\n(?=\d+\.\s+\*\*)/);
  const out: RocketInboxThread[] = [];
  for (const block of blocks) {
    const head = block.match(/\d+\.\s+\*\*(.*?)\*\*/);
    const idMatch = block.match(/Thread ID:\s*`?([^`\s|]+)`?/i);
    if (!idMatch) continue;
    const t: RocketInboxThread = {
      thread_id: idMatch[1],
      subject: head ? head[1].trim() : undefined,
    };
    const status = block.match(/Status:\s*([a-z_]+)/i);
    const lead = block.match(/(?:Lead\s*)?Email:\s*([^\s|]+@[^\s|]+)/i);
    const leadName = block.match(/Lead(?:\s*Name)?:\s*([^|\n]+)/i);
    const campaign = block.match(/Campaign:\s*([^|\n]+)/i);
    const last = block.match(/(?:Last\s*(?:Message)?|Updated):\s*`?([0-9T:.\-Z]+)`?/i);
    const preview = block.match(/Preview:\s*"?([^"\n]+)"?/i);
    if (status) t.intent_label = status[1];
    if (lead) t.lead_email = lead[1];
    if (leadName) t.lead_name = leadName[1].trim();
    if (campaign) t.campaign_name = campaign[1].trim();
    if (last) t.last_message_at = last[1];
    if (preview) t.last_message_preview = preview[1];
    out.push(t);
  }
  return out;
}

/**
 * Get the inbox feed (every reply thread across campaigns). Rocket returns
 * 200 OK wrapping its own internal-error text rather than a proper RPC error
 * envelope — treat any leading "Error" as a hard failure.
 */
export async function getInbox(
  args: { limit?: number; unread_only?: boolean; campaign_id?: string } = {},
  opts?: CallOpts,
): Promise<{ threads: RocketInboxThread[]; raw: string }> {
  const result = await callTool<McpContent>("get_inbox", { ...args }, opts);
  const raw = pluckText(result);
  if (/^\s*Error\b/i.test(raw)) {
    throw new Error(`Rocket get_inbox returned error text: ${raw.slice(0, 200)}`);
  }
  return { threads: parseInboxList(raw), raw };
}

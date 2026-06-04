import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertAgnbAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: marketing assets + fills (CRUD).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/marketing (route, [id], fill).
 *
 * Tables: agnb.marketing_assets, agnb.filled_assets.
 *
 * PHASE 5: the asset detail page's AI fill (POST /marketing/:id/ai-fill) calls
 * Gemini to extract variable values from free text — external LLM, not a pure
 * DB op. Left cross-origin in the UI. The PDF render endpoint (POST
 * /marketing/pdf) is also external and stays cross-origin.
 */

// ---------------------------------------------------------------------------
// Variable extractor (ported from agnb lib/agnb/asset-vars.ts).
// `marketing_assets.variables` (jsonb) stores the extracted AssetVar[] so the
// create/patch parity with AGNB is preserved.
// ---------------------------------------------------------------------------
type VarType = "text" | "number" | "date" | "image" | "textarea";
interface AssetVar {
  name: string;
  type: VarType;
  label: string;
  defaultValue: string;
}

const VAR_TYPES = new Set<VarType>(["text", "number", "date", "image", "textarea"]);
const ACRONYMS = new Set([
  "inr", "usd", "eur", "gbp",
  "did", "dnc", "did_pool",
  "ifsc", "gst", "gstin", "pan", "tan", "iban", "swift", "ach", "upi",
  "kyc", "aml", "soc2", "soc", "hipaa", "pci", "dpdp", "gdpr", "sla", "mou", "nda",
  "api", "sdk", "url", "uri", "ssl", "tls", "jwt", "hmac",
  "mrr", "arr", "cac", "ltv", "cogs", "ebitda", "ebit",
  "rfp", "rfq", "po", "sow", "msa", "eula",
  "ai", "ml", "llm", "rag", "tts", "stt", "asr", "nlu",
  "crm", "erp", "saas", "paas", "iaas", "etl",
]);

function stripBlocks(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ");
}

function humanize(name: string): string {
  return name
    .split("_")
    .map((tok) =>
      ACRONYMS.has(tok.toLowerCase())
        ? tok.toUpperCase()
        : tok.charAt(0).toUpperCase() + tok.slice(1),
    )
    .join(" ");
}

function asVar(name: string, rawType: string | undefined): AssetVar {
  const t = (rawType ?? "text").toLowerCase();
  const type: VarType = (VAR_TYPES.has(t as VarType) ? t : "text") as VarType;
  return {
    name,
    type,
    label: humanize(name),
    defaultValue: type === "date" ? new Date().toISOString().slice(0, 10) : "",
  };
}

function extractVars(html: string): AssetVar[] {
  const cleaned = stripBlocks(html);
  const seen = new Map<string, AssetVar>();

  const mustache = /\{\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*([a-z]+))?\s*\}\}/gi;
  let m: RegExpExecArray | null;
  while ((m = mustache.exec(cleaned)) !== null) {
    const name = m[1].toLowerCase();
    if (!seen.has(name)) seen.set(name, asVar(name, m[2]));
  }

  const single = /(?<!\{)\{\s*([a-z_][a-z0-9_]*)(?:\s*\|\s*([a-z]+))?\s*\}(?!\})/gi;
  while ((m = single.exec(cleaned)) !== null) {
    const name = m[1].toLowerCase();
    if (seen.has(name)) continue;
    if (/[:;=]/.test(m[0])) continue;
    seen.set(name, asVar(name, m[2]));
  }

  return Array.from(seen.values());
}

/** First ~140 chars of the asset body, tags stripped, {{vars}} → … */
function bodyPreview(html: string): string {
  const m = html.match(/<div class="body"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return "";
  return m[1]
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\{[^}]+\}\}/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

interface BaseAssetRow {
  id: string;
  title: string;
  stage: string;
  kind: string;
  status: string;
  version: number;
  updated_at: string;
  created_by: string;
  html: string;
  variables: unknown;
  notes: string | null;
}

export function registerMarketing(router: Router, db: Db) {
  /** GET /api/agnb/marketing?q= — asset list + per-asset fill stats. */
  router.get("/agnb/marketing", async (req, res) => {
    assertAgnbAccess(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const assetsResult = q
      ? await db.execute(sql`
          SELECT id, title, stage, kind, status, version, updated_at, created_by, html, variables, notes
          FROM agnb.marketing_assets
          WHERE title ILIKE ${"%" + q + "%"}
          ORDER BY updated_at DESC
          LIMIT 500
        `)
      : await db.execute(sql`
          SELECT id, title, stage, kind, status, version, updated_at, created_by, html, variables, notes
          FROM agnb.marketing_assets
          ORDER BY updated_at DESC
          LIMIT 500
        `);
    const baseRows = rows<BaseAssetRow>(assetsResult);

    const ids = baseRows.map((r) => r.id);
    const fills =
      ids.length > 0
        ? rows<{ asset_id: string; customer_name: string | null; created_at: string }>(
            await db.execute(sql`
              SELECT asset_id, customer_name, created_at
              FROM agnb.filled_assets
              WHERE asset_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
              ORDER BY created_at DESC
            `),
          )
        : [];

    const fillStats = new Map<
      string,
      { count: number; last_at: string; last_customer: string | null }
    >();
    for (const f of fills) {
      const cur = fillStats.get(f.asset_id);
      if (cur) cur.count++;
      else fillStats.set(f.asset_id, { count: 1, last_at: f.created_at, last_customer: f.customer_name });
    }

    const assets = baseRows.map((r) => {
      const s = fillStats.get(r.id);
      return {
        ...r,
        fill_count: s?.count ?? 0,
        last_fill_at: s?.last_at ?? null,
        last_fill_customer: s?.last_customer ?? null,
        body_preview: bodyPreview(r.html),
      };
    });

    res.json({ ok: true, assets });
  });

  /** GET /api/agnb/marketing/:id — single asset + recent fills. */
  router.get("/agnb/marketing/:id", async (req, res) => {
    assertAgnbAccess(req);
    const id = req.params.id;
    const asset = rows<BaseAssetRow>(
      await db.execute(sql`
        SELECT id, title, stage, kind, html, variables, status, version, notes, updated_at, created_by
        FROM agnb.marketing_assets
        WHERE id = ${id}
        LIMIT 1
      `),
    )[0];
    if (!asset) return res.status(404).json({ ok: false, error: "not found" });
    const fills = rows(
      await db.execute(sql`
        SELECT id, customer_name, created_at, created_by
        FROM agnb.filled_assets
        WHERE asset_id = ${id}
        ORDER BY created_at DESC
        LIMIT 20
      `),
    );
    res.json({ ok: true, asset, fills });
  });

  /** POST /api/agnb/marketing — create an asset. Returns { ok, id }. */
  router.post("/agnb/marketing", async (req, res) => {
    assertAgnbAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as {
      title?: string;
      stage?: string;
      kind?: string;
      html?: string;
      status?: "draft" | "active";
      notes?: string | null;
    };

    if (!body.title || !body.stage || !body.kind || !body.html) {
      return res.status(400).json({ ok: false, error: "title, stage, kind, html required" });
    }

    const variables = extractVars(body.html);
    const result = await db.execute(sql`
      INSERT INTO agnb.marketing_assets (title, stage, kind, html, variables, status, notes, created_by)
      VALUES (
        ${body.title}, ${body.stage}, ${body.kind}, ${body.html},
        ${JSON.stringify(variables)}::jsonb, ${body.status ?? "draft"}, ${body.notes ?? null}, ${email}
      )
      RETURNING id
    `);
    const id = rows<{ id: string }>(result)[0]?.id;
    res.json({ ok: true, id });
  });

  /** PATCH /api/agnb/marketing?id= — update html / metadata / status. */
  router.patch("/agnb/marketing", async (req, res) => {
    assertAgnbAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const body = (req.body ?? {}) as {
      title?: string;
      stage?: string;
      kind?: string;
      html?: string;
      status?: "draft" | "active" | "archived";
      notes?: string | null;
      bumpVersion?: boolean;
    };

    const sets = [sql`updated_at = ${new Date().toISOString()}`];
    if (body.title !== undefined) sets.push(sql`title = ${body.title}`);
    if (body.stage !== undefined) sets.push(sql`stage = ${body.stage}`);
    if (body.kind !== undefined) sets.push(sql`kind = ${body.kind}`);
    if (body.status !== undefined) sets.push(sql`status = ${body.status}`);
    if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
    if (body.html !== undefined) {
      sets.push(sql`html = ${body.html}`);
      sets.push(sql`variables = ${JSON.stringify(extractVars(body.html))}::jsonb`);
    }
    if (body.bumpVersion) {
      const cur = rows<{ version: number | null }>(
        await db.execute(sql`SELECT version FROM agnb.marketing_assets WHERE id = ${id} LIMIT 1`),
      )[0];
      sets.push(sql`version = ${(cur?.version ?? 0) + 1}`);
    }

    await db.execute(sql`
      UPDATE agnb.marketing_assets
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** POST /api/agnb/marketing/fill — record a fill. Returns { ok, id }. */
  router.post("/agnb/marketing/fill", async (req, res) => {
    assertAgnbAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as {
      asset_id?: string;
      customer_name?: string | null;
      variables_used?: Record<string, string>;
      html_rendered?: string;
    };

    if (!body.asset_id || !body.html_rendered) {
      return res.status(400).json({ ok: false, error: "asset_id + html_rendered required" });
    }

    const result = await db.execute(sql`
      INSERT INTO agnb.filled_assets (asset_id, customer_name, variables_used, html_rendered, created_by)
      VALUES (
        ${body.asset_id}, ${body.customer_name ?? null},
        ${JSON.stringify(body.variables_used ?? {})}::jsonb, ${body.html_rendered}, ${email}
      )
      RETURNING id
    `);
    const id = rows<{ id: string }>(result)[0]?.id;
    res.json({ ok: true, id });
  });
}

import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertAgnbAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: blog drafts + ideas + schedule settings (reads + pure-DB CRUD),
 * plus content-audit / utm-hygiene scan-result reads.
 * Ported from agnb app/all-gas-no-brakes/api/agnb/blog-automation,
 * blog/save, blog/ideas, blog/schedule-settings, content-audit, utm-hygiene.
 *
 * SKIPPED (external/LLM/sync), left cross-origin in the UI:
 *  - blog/ai-draft       → Gemini (LLM)
 *  - blog/[id]/repurpose → Gemini (LLM)
 *  - blog/[id]/publish   → GitHub commit + Cloud Run rebuild (external)
 */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export function registerBlog(router: Router, db: Db) {
  /** GET /api/agnb/blog-automation — blog drafts (Draft blogs / Review queue / Calendar). */
  router.get("/agnb/blog-automation", async (req, res) => {
    assertAgnbAccess(req);
    const result = await db.execute(sql`
      SELECT id, title, slug, description, status, cluster_type, scheduled_at,
             published_at, deployment_url, github_pr_url, error_message,
             created_by, updated_at, created_at
      FROM agnb.blog_drafts
      ORDER BY updated_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, drafts: rows(result) });
  });

  /** PATCH /api/agnb/blog-automation?id= — schedule / update draft. Body: { status?, scheduled_at?, title?, description? } */
  router.patch("/agnb/blog-automation", async (req, res) => {
    assertAgnbAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, unknown>;

    const sets = [sql`updated_at = ${new Date().toISOString()}`];
    if ("status" in body) sets.push(sql`status = ${body.status as string | null}`);
    if ("scheduled_at" in body) sets.push(sql`scheduled_at = ${body.scheduled_at as string | null}`);
    if ("title" in body) sets.push(sql`title = ${body.title as string | null}`);
    if ("description" in body) sets.push(sql`description = ${body.description as string | null}`);

    await db.execute(sql`
      UPDATE agnb.blog_drafts SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/blog-automation?id= */
  router.delete("/agnb/blog-automation", async (req, res) => {
    assertAgnbAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.blog_drafts WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /**
   * POST /api/agnb/blog/save
   * Body: { id?, title, slug?, description?, mdx_body?, frontmatter?, status?, scheduled_at? }
   * Upsert a blog draft. `id` present → update; absent → insert.
   * `slug` must be unique; returns 409 on collision.
   */
  router.post("/agnb/blog/save", async (req, res) => {
    assertAgnbAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as {
      id?: string;
      title?: string;
      slug?: string;
      description?: string;
      mdx_body?: string;
      frontmatter?: Record<string, unknown>;
      status?: string;
      scheduled_at?: string | null;
    };

    const title = String(body.title ?? "").trim();
    if (!title) return res.status(400).json({ ok: false, error: "title required" });
    const slug = body.slug?.trim() || slugify(title);
    const validStatuses = new Set(["draft", "scheduled", "publishing", "published", "failed"]);
    const status = validStatuses.has(body.status ?? "") ? body.status! : "draft";
    if (status === "scheduled" && !body.scheduled_at) {
      return res.status(400).json({ ok: false, error: "scheduled_at required when status=scheduled" });
    }

    const description = body.description?.trim() || null;
    const mdxBody = body.mdx_body ?? "";
    const frontmatter = JSON.stringify({ published: true, ...(body.frontmatter ?? {}) });
    const scheduledAt = body.scheduled_at ?? null;
    const updatedAt = new Date().toISOString();

    if (body.id) {
      const result = await db.execute(sql`
        UPDATE agnb.blog_drafts SET
          title = ${title}, slug = ${slug}, description = ${description},
          mdx_body = ${mdxBody}, frontmatter = ${frontmatter}::jsonb, status = ${status},
          scheduled_at = ${scheduledAt}, updated_at = ${updatedAt}
        WHERE id = ${body.id}
        RETURNING *
      `);
      return res.json({ ok: true, row: rows(result)[0] });
    }

    try {
      const result = await db.execute(sql`
        INSERT INTO agnb.blog_drafts
          (title, slug, description, mdx_body, frontmatter, status, scheduled_at, updated_at, created_by)
        VALUES
          (${title}, ${slug}, ${description}, ${mdxBody}, ${frontmatter}::jsonb, ${status},
           ${scheduledAt}, ${updatedAt}, ${email})
        RETURNING *
      `);
      return res.json({ ok: true, row: rows(result)[0] });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/duplicate key/i.test(message)) {
        return res.status(409).json({ ok: false, error: `slug "${slug}" already exists` });
      }
      return res.status(500).json({ ok: false, error: message });
    }
  });

  /** POST /api/agnb/blog/ideas — insert a blog idea. Body: { raw_text, source?, related_topic?, notes? } */
  router.post("/agnb/blog/ideas", async (req, res) => {
    assertAgnbAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as {
      raw_text?: string;
      source?: string;
      related_topic?: string;
      notes?: string;
    };
    if (!body.raw_text?.trim()) return res.status(400).json({ ok: false, error: "raw_text required" });
    const result = await db.execute(sql`
      INSERT INTO agnb.blog_ideas (raw_text, source, related_topic, notes, created_by)
      VALUES (${body.raw_text.trim()}, ${body.source ?? "manual"}, ${body.related_topic ?? null},
              ${body.notes?.trim() ?? null}, ${email})
      RETURNING *
    `);
    res.json({ ok: true, row: rows(result)[0] });
  });

  /** PATCH /api/agnb/blog/ideas?id= — update status / notes. */
  router.patch("/agnb/blog/ideas", async (req, res) => {
    assertAgnbAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as { status?: string; notes?: string };
    const sets: ReturnType<typeof sql>[] = [];
    if (body.status) sets.push(sql`status = ${body.status}`);
    if (body.notes) sets.push(sql`notes = ${body.notes}`);
    if (sets.length > 0) {
      await db.execute(sql`UPDATE agnb.blog_ideas SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    }
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/blog/ideas?id= */
  router.delete("/agnb/blog/ideas", async (req, res) => {
    assertAgnbAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.blog_ideas WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /** GET /api/agnb/blog/schedule-settings — singleton row (id=1). */
  router.get("/agnb/blog/schedule-settings", async (req, res) => {
    assertAgnbAccess(req);
    const result = await db.execute(sql`
      SELECT * FROM agnb.blog_schedule_settings WHERE id = 1
    `);
    res.json({ ok: true, settings: rows(result)[0] ?? null });
  });

  /** PATCH /api/agnb/blog/schedule-settings — update cadence_days, preferred_dow, preferred_hour, timezone, enabled. */
  router.patch("/agnb/blog/schedule-settings", async (req, res) => {
    assertAgnbAccess(req);
    const body = (req.body ?? {}) as {
      cadence_days?: number;
      preferred_dow?: number;
      preferred_hour?: number;
      timezone?: string;
      enabled?: boolean;
    };
    const sets = [sql`updated_at = ${new Date().toISOString()}`];
    if (typeof body.cadence_days === "number" && body.cadence_days >= 1 && body.cadence_days <= 90)
      sets.push(sql`cadence_days = ${body.cadence_days}`);
    if (typeof body.preferred_dow === "number" && body.preferred_dow >= 0 && body.preferred_dow <= 6)
      sets.push(sql`preferred_dow = ${body.preferred_dow}`);
    if (typeof body.preferred_hour === "number" && body.preferred_hour >= 0 && body.preferred_hour <= 23)
      sets.push(sql`preferred_hour = ${body.preferred_hour}`);
    if (typeof body.timezone === "string" && body.timezone.length > 0)
      sets.push(sql`timezone = ${body.timezone}`);
    if (typeof body.enabled === "boolean") sets.push(sql`enabled = ${body.enabled}`);

    await db.execute(sql`
      UPDATE agnb.blog_schedule_settings SET ${sql.join(sets, sql`, `)} WHERE id = 1
    `);
    res.json({ ok: true });
  });

  /** GET /api/agnb/content-audit — open content-audit issues (resolved_at IS NULL). */
  router.get("/agnb/content-audit", async (req, res) => {
    assertAgnbAccess(req);
    const result = await db.execute(sql`
      SELECT id, blog_path, blog_title, issue_type, severity, details, detected_at, resolved_at
      FROM agnb.content_audit_issues
      WHERE resolved_at IS NULL
      ORDER BY severity DESC, detected_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, issues: rows(result) });
  });

  /** GET /api/agnb/utm-hygiene — open UTM-hygiene issues (resolved_at IS NULL). */
  router.get("/agnb/utm-hygiene", async (req, res) => {
    assertAgnbAccess(req);
    const result = await db.execute(sql`
      SELECT id, source_kind, source_id, source_name, url, issue_type, severity, details, detected_at, resolved_at
      FROM agnb.utm_hygiene_issues
      WHERE resolved_at IS NULL
      ORDER BY detected_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, issues: rows(result) });
  });

  // ── Sense-layer reads for Paperclip agents (Content Strategist / Blog Writer) ──
  // The cron jobs (gap-analyzer, sitemap-scraper, gsc-rank-tracker) keep producing
  // this data at scale; these endpoints let the drafting agents CONSUME it as
  // grounding instead of guessing via web search.

  /** GET /api/agnb/content-gaps?min=25&limit=25&status=identified — top SEO gaps for briefing. */
  router.get("/agnb/content-gaps", async (req, res) => {
    assertAgnbAccess(req);
    const min = Number(req.query.min ?? 25) || 0;
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 200);
    const status = typeof req.query.status === "string" ? req.query.status : "identified";
    const result = await db.execute(sql`
      SELECT id, topic, gap_score, competitor_count, our_coverage_count,
             suggested_keywords, representative_titles, status, suggestion_type,
             cluster_type, parent_topic
      FROM agnb.content_gaps
      WHERE status = ${status} AND gap_score >= ${min}
      ORDER BY gap_score DESC NULLS LAST, updated_at DESC
      LIMIT ${limit}
    `);
    res.json({ ok: true, gaps: rows(result) });
  });

  /** PATCH /api/agnb/content-gaps/:id — mark a gap consumed. Body: { status?, ignored_reason? } */
  router.patch("/agnb/content-gaps/:id", async (req, res) => {
    assertAgnbAccess(req);
    const id = req.params.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sets = [sql`updated_at = ${new Date().toISOString()}`];
    if ("status" in body) sets.push(sql`status = ${body.status as string | null}`);
    if ("ignored_reason" in body) sets.push(sql`ignored_reason = ${body.ignored_reason as string | null}`);
    await db.execute(sql`UPDATE agnb.content_gaps SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /** GET /api/agnb/competitor-blogs?q=<keyword>&limit=20 — corpus retrieval for draft grounding. */
  router.get("/agnb/competitor-blogs", async (req, res) => {
    assertAgnbAccess(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const like = `%${q}%`;
    const where = q
      ? sql`WHERE title ILIKE ${like} OR description ILIKE ${like}
             OR array_to_string(topics, ' ') ILIKE ${like}
             OR array_to_string(keywords, ' ') ILIKE ${like}`
      : sql``;
    const result = await db.execute(sql`
      SELECT id, url, title, description, content_excerpt, topics, keywords, published_at
      FROM agnb.competitor_blogs
      ${where}
      ORDER BY published_at DESC NULLS LAST
      LIMIT ${limit}
    `);
    res.json({ ok: true, blogs: rows(result) });
  });

  /** GET /api/agnb/gsc-rank-data?limit=100 — Search Console rank rows (feedback signal). */
  router.get("/agnb/gsc-rank-data", async (req, res) => {
    assertAgnbAccess(req);
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const result = await db.execute(sql`
      SELECT blog_url, query, position, clicks, impressions, ctr, capture_date
      FROM agnb.gsc_rank_data
      ORDER BY capture_date DESC, impressions DESC NULLS LAST
      LIMIT ${limit}
    `);
    res.json({ ok: true, ranks: rows(result) });
  });

  // PHASE 5: POST /agnb/blog/ai-draft calls Gemini (LLM) — external API. Left cross-origin in the UI.
  // PHASE 5: POST /agnb/blog/[id]/repurpose calls Gemini (LLM) — external API. Left cross-origin in the UI.
  // PHASE 5: POST /agnb/blog/[id]/publish performs GitHub commit + Cloud Run rebuild — external. Left cross-origin in the UI.
}

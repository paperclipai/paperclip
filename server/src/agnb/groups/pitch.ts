import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertAgnbAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";
import { generatePitch, renderPitch } from "../pitch/index.js";

/**
 * AGNB group: Finn pitch-deck generator (ported from the standalone finn-pitch
 * repo into the Assets area). Tables: agnb.pitch_decks.
 *
 * Generation (POST /generate) shells out to the local `claude` CLI — dev-only,
 * returns 503 where the CLI is absent (e.g. Cloud Run). The rendered HTML is
 * stored and served read-only everywhere (GET /:id/content).
 */

interface PitchListRow {
  id: string;
  client_name: string;
  vertical: string | null;
  deck_title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// Deck HTML loads reveal.js + Google fonts from CDNs and pulls screenshots /
// nested mockups from the public asset bucket — allow exactly those origins.
const DECK_CSP = [
  "default-src 'none'",
  "img-src https://storage.googleapis.com data:",
  "frame-src https://storage.googleapis.com",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src https://fonts.gstatic.com",
  "connect-src 'none'",
].join("; ");

// Pitch decks are generated dev-only (local DB). Deployed instances may not have
// the table at all (0003 not applied) — treat "relation does not exist" as empty.
function isMissingTable(e: unknown): boolean {
  if ((e as { code?: string })?.code === "42P01") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /relation .*pitch_decks.* does not exist|42P01/i.test(msg);
}

export function registerPitch(router: Router, db: Db) {
  /** GET /api/agnb/pitch — list decks (meta only). */
  router.get("/agnb/pitch", async (req, res) => {
    assertAgnbAccess(req);
    try {
      const decks = rows<PitchListRow>(
        await db.execute(sql`
          SELECT id, client_name, vertical, deck_title, created_by, created_at, updated_at
          FROM agnb.pitch_decks
          ORDER BY updated_at DESC
          LIMIT 200
        `),
      );
      res.json({ ok: true, decks });
    } catch (e) {
      if (isMissingTable(e)) return res.json({ ok: true, decks: [] });
      throw e;
    }
  });

  /** GET /api/agnb/pitch/:id — single deck (meta + slides + answers, no html). */
  router.get("/agnb/pitch/:id", async (req, res) => {
    assertAgnbAccess(req);
    let deck: unknown;
    try {
      deck = rows(
        await db.execute(sql`
          SELECT id, client_name, vertical, deck_title, slides, answers, created_by, created_at, updated_at
          FROM agnb.pitch_decks WHERE id = ${req.params.id} LIMIT 1
        `),
      )[0];
    } catch (e) {
      if (isMissingTable(e)) return res.status(404).json({ ok: false, error: "not found" });
      throw e;
    }
    if (!deck) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, deck });
  });

  /** GET /api/agnb/pitch/:id/content — the rendered reveal.js HTML (for iframe). */
  router.get("/agnb/pitch/:id/content", async (req, res) => {
    assertAgnbAccess(req);
    let row: { html: string } | undefined;
    try {
      row = rows<{ html: string }>(
        await db.execute(sql`SELECT html FROM agnb.pitch_decks WHERE id = ${req.params.id} LIMIT 1`),
      )[0];
    } catch (e) {
      if (isMissingTable(e)) return res.status(404).send("not found");
      throw e;
    }
    if (!row) return res.status(404).send("not found");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", DECK_CSP);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(row.html);
  });

  /** POST /api/agnb/pitch/generate — intake → claude → render → store. Dev-only. */
  router.post("/agnb/pitch/generate", async (req, res) => {
    assertAgnbAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const answers = (req.body ?? {}) as Record<string, unknown>;
    if (!answers.clientName || typeof answers.clientName !== "string") {
      return res.status(400).json({ ok: false, error: "clientName required" });
    }

    let html: string;
    let deckTitle = "Untitled";
    let slides: unknown = [];
    try {
      const deck = await generatePitch(answers);
      html = await renderPitch(deck);
      deckTitle = (deck.deckTitle as string) || deckTitle;
      slides = deck.slides ?? [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[pitch.generate] failed:", msg);
      // `claude` binary absent (Cloud Run) → ENOENT/spawn error naming the CLI.
      if (/claude/i.test(msg) && /ENOENT|spawn|not found/i.test(msg)) {
        return res.status(503).json({
          ok: false,
          error: "Pitch generation runs only in local dev (requires the `claude` CLI).",
        });
      }
      return res.status(500).json({ ok: false, error: msg });
    }

    const result = await db.execute(sql`
      INSERT INTO agnb.pitch_decks (client_name, vertical, deck_title, slides, html, answers, created_by)
      VALUES (
        ${answers.clientName}, ${(answers.industry as string) ?? null}, ${deckTitle},
        ${JSON.stringify(slides)}::jsonb, ${html}, ${JSON.stringify(answers)}::jsonb, ${email}
      )
      RETURNING id
    `);
    const id = rows<{ id: string }>(result)[0]?.id;
    res.json({ ok: true, id });
  });

  /** DELETE /api/agnb/pitch/:id. */
  router.delete("/agnb/pitch/:id", async (req, res) => {
    assertAgnbAccess(req);
    await db.execute(sql`DELETE FROM agnb.pitch_decks WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  });
}

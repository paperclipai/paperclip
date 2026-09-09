import { Router } from "express";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { journalEntries } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

export function journalRoutes(db: Db) {
  const router = Router();

  /**
   * GET /journal
   * Returns journal entries for the authenticated user within [from, to].
   * Ordered by entryDate desc. Max range: 365 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/journal", async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from) throw badRequest("from must be YYYY-MM-DD");
    if (!to) throw badRequest("to must be YYYY-MM-DD");
    if (to < from) throw badRequest("to must be >= from");

    const msPerDay = 86_400_000;
    const dayCount =
      Math.round((new Date(to).getTime() - new Date(from).getTime()) / msPerDay) + 1;
    if (dayCount > 365) throw badRequest("date range must not exceed 365 days");

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalEntries.userId, userId),
          gte(journalEntries.entryDate, from),
          lte(journalEntries.entryDate, to),
        ),
      )
      .orderBy(desc(journalEntries.entryDate));

    res.json({ from, to, entries: rows });
  });

  /**
   * POST /journal
   * Create a new journal entry.
   * Body: { companyId, entryDate, body, title?, moodScore?, tags?, isPrivate? }
   */
  router.post("/journal", async (req, res) => {
    assertBoard(req);

    const b = req.body as Record<string, unknown>;
    const companyId = typeof b["companyId"] === "string" ? b["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const entryDate = parseDate(b["entryDate"]);
    if (!entryDate) throw badRequest("entryDate must be YYYY-MM-DD");

    const body = typeof b["body"] === "string" ? b["body"].trim() : null;
    if (!body) throw badRequest("body is required");

    const title = typeof b["title"] === "string" ? b["title"].trim() || null : null;

    let moodScore: number | null = null;
    if (b["moodScore"] !== undefined && b["moodScore"] !== null) {
      if (typeof b["moodScore"] !== "number" || !Number.isInteger(b["moodScore"])) {
        throw badRequest("moodScore must be an integer");
      }
      if (b["moodScore"] < 1 || b["moodScore"] > 10) {
        throw badRequest("moodScore must be between 1 and 10");
      }
      moodScore = b["moodScore"];
    }

    let tags: string[] = [];
    if (Array.isArray(b["tags"])) {
      if (!b["tags"].every((t) => typeof t === "string")) {
        throw badRequest("tags must be an array of strings");
      }
      tags = b["tags"].map((t: string) => t.trim()).filter(Boolean);
    }

    const isPrivate = b["isPrivate"] === false ? false : true;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(journalEntries)
      .values({
        companyId,
        userId,
        entryDate,
        title: title ?? undefined,
        body,
        moodScore: moodScore ?? undefined,
        tags,
        isPrivate,
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * PATCH /journal/:id
   * Update a journal entry (title, body, moodScore, tags, isPrivate).
   */
  router.patch("/journal/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(journalEntries).where(eq(journalEntries.id, id));
    if (!existing) throw notFound("Journal entry not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Journal entry not found");

    const b = req.body as Record<string, unknown>;
    const updates: Partial<typeof journalEntries.$inferInsert> = {};

    if (b["title"] !== undefined) {
      updates.title = typeof b["title"] === "string" ? b["title"].trim() || null : null;
    }
    if (b["body"] !== undefined) {
      if (typeof b["body"] !== "string" || !b["body"].trim()) {
        throw badRequest("body must be a non-empty string");
      }
      updates.body = b["body"].trim();
    }
    if (b["moodScore"] !== undefined && b["moodScore"] !== null) {
      if (typeof b["moodScore"] !== "number" || !Number.isInteger(b["moodScore"])) {
        throw badRequest("moodScore must be an integer");
      }
      if (b["moodScore"] < 1 || b["moodScore"] > 10) {
        throw badRequest("moodScore must be between 1 and 10");
      }
      updates.moodScore = b["moodScore"];
    }
    if (b["moodScore"] === null) {
      updates.moodScore = undefined;
    }
    if (Array.isArray(b["tags"])) {
      if (!b["tags"].every((t) => typeof t === "string")) {
        throw badRequest("tags must be an array of strings");
      }
      updates.tags = b["tags"].map((t: string) => t.trim()).filter(Boolean);
    }
    if (typeof b["isPrivate"] === "boolean") {
      updates.isPrivate = b["isPrivate"];
    }

    updates.updatedAt = new Date();

    const [row] = await db
      .update(journalEntries)
      .set(updates)
      .where(eq(journalEntries.id, id))
      .returning();

    res.json(row);
  });

  /**
   * DELETE /journal/:id
   * Remove a journal entry by id.
   */
  router.delete("/journal/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(journalEntries).where(eq(journalEntries.id, id));
    if (!existing) throw notFound("Journal entry not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Journal entry not found");

    await db.delete(journalEntries).where(eq(journalEntries.id, id));
    res.status(204).send();
  });

  return router;
}

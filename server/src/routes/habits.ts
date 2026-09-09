import { Router } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { habitDefinitions, habitCompletions } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

export function habitsRoutes(db: Db) {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Habit Definitions
  // ---------------------------------------------------------------------------

  /** GET /habits?companyId — list active habits for the user */
  router.get("/habits", async (req, res) => {
    assertBoard(req);

    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(habitDefinitions)
      .where(
        and(
          eq(habitDefinitions.companyId, companyId),
          eq(habitDefinitions.userId, userId),
          eq(habitDefinitions.isActive, true),
        ),
      )
      .orderBy(desc(habitDefinitions.createdAt));

    res.json({ habits: rows });
  });

  /** POST /habits — create a new habit */
  router.post("/habits", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const name = typeof body["name"] === "string" ? body["name"].trim() : null;
    if (!name) throw badRequest("name is required");

    const description =
      typeof body["description"] === "string" ? body["description"].trim() || null : null;

    let color = "#6366f1";
    if (body["color"] !== undefined) {
      if (typeof body["color"] !== "string" || !COLOR_RE.test(body["color"])) {
        throw badRequest("color must be a valid hex color (e.g. #6366f1)");
      }
      color = body["color"];
    }

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(habitDefinitions)
      .values({ companyId, userId, name, description: description ?? undefined, color })
      .returning();

    res.status(201).json(row);
  });

  /** PATCH /habits/:id — update name/description/color/isActive */
  router.patch("/habits/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db
      .select()
      .from(habitDefinitions)
      .where(eq(habitDefinitions.id, id));
    if (!existing) throw notFound("Habit not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Habit not found");

    const body = req.body as Record<string, unknown>;
    const updates: Partial<typeof habitDefinitions.$inferInsert> = {};

    if (typeof body["name"] === "string") {
      const name = body["name"].trim();
      if (!name) throw badRequest("name must not be empty");
      updates.name = name;
    }
    if (body["description"] !== undefined) {
      updates.description =
        typeof body["description"] === "string" ? body["description"].trim() || null : null;
    }
    if (body["color"] !== undefined) {
      if (typeof body["color"] !== "string" || !COLOR_RE.test(body["color"])) {
        throw badRequest("color must be a valid hex color");
      }
      updates.color = body["color"];
    }
    if (typeof body["isActive"] === "boolean") {
      updates.isActive = body["isActive"];
    }

    updates.updatedAt = new Date();

    const [row] = await db
      .update(habitDefinitions)
      .set(updates)
      .where(eq(habitDefinitions.id, id))
      .returning();

    res.json(row);
  });

  /** DELETE /habits/:id — soft-delete (sets isActive = false) */
  router.delete("/habits/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db
      .select()
      .from(habitDefinitions)
      .where(eq(habitDefinitions.id, id));
    if (!existing) throw notFound("Habit not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Habit not found");

    await db
      .update(habitDefinitions)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(habitDefinitions.id, id));

    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Habit Completions
  // ---------------------------------------------------------------------------

  /**
   * GET /habits/completions?companyId&from&to
   * Returns completions for the user within [from, to]. Max range: 90 days.
   */
  router.get("/habits/completions", async (req, res) => {
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
    if (dayCount > 90) throw badRequest("date range must not exceed 90 days");

    const userId =
      typeof req.query.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const rows = await db
      .select()
      .from(habitCompletions)
      .where(
        and(
          eq(habitCompletions.companyId, companyId),
          eq(habitCompletions.userId, userId),
          gte(habitCompletions.completionDate, from),
          lte(habitCompletions.completionDate, to),
        ),
      )
      .orderBy(desc(habitCompletions.completionDate));

    res.json({ from, to, completions: rows });
  });

  /**
   * POST /habits/:habitId/complete
   * Mark a habit as done for a given date (idempotent — ON CONFLICT DO NOTHING).
   * Body: { completionDate, notes? }
   */
  router.post("/habits/:habitId/complete", async (req, res) => {
    assertBoard(req);
    const { habitId } = req.params as { habitId: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [habit] = await db
      .select()
      .from(habitDefinitions)
      .where(eq(habitDefinitions.id, habitId));
    if (!habit) throw notFound("Habit not found");
    assertCompanyAccess(req, habit.companyId);
    if (habit.userId !== userId) throw notFound("Habit not found");

    const body = req.body as Record<string, unknown>;
    const completionDate = parseDate(body["completionDate"]);
    if (!completionDate) throw badRequest("completionDate must be YYYY-MM-DD");
    const notes = typeof body["notes"] === "string" ? body["notes"].trim() || null : null;

    const existing = await db
      .select()
      .from(habitCompletions)
      .where(
        and(
          eq(habitCompletions.habitId, habitId),
          eq(habitCompletions.completionDate, completionDate),
        ),
      );

    if (existing.length > 0) {
      return res.json(existing[0]);
    }

    const [row] = await db
      .insert(habitCompletions)
      .values({
        habitId,
        companyId: habit.companyId,
        userId,
        completionDate,
        notes: notes ?? undefined,
      })
      .returning();

    return res.status(201).json(row);
  });

  /**
   * DELETE /habits/:habitId/complete/:completionDate
   * Unmark a habit completion for a given date.
   */
  router.delete("/habits/:habitId/complete/:completionDate", async (req, res) => {
    assertBoard(req);
    const { habitId, completionDate } = req.params as {
      habitId: string;
      completionDate: string;
    };

    if (!DATE_RE.test(completionDate)) throw badRequest("completionDate must be YYYY-MM-DD");

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [habit] = await db
      .select()
      .from(habitDefinitions)
      .where(eq(habitDefinitions.id, habitId));
    if (!habit) throw notFound("Habit not found");
    assertCompanyAccess(req, habit.companyId);
    if (habit.userId !== userId) throw notFound("Habit not found");

    await db
      .delete(habitCompletions)
      .where(
        and(
          eq(habitCompletions.habitId, habitId),
          eq(habitCompletions.completionDate, completionDate),
        ),
      );

    res.status(204).send();
  });

  return router;
}

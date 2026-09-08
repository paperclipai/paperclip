import { Router } from "express";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { symptomLogs } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_SYMPTOMS = new Set([
  "headache", "fatigue", "nausea", "sore_throat", "runny_nose",
  "cough", "chest_pain", "shortness_of_breath", "dizziness", "body_aches",
  "fever", "chills", "stomach_pain", "back_pain", "anxiety", "insomnia", "other",
]);

function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim();
  return DATE_RE.test(d) ? d : null;
}

export function symptomsRoutes(db: Db) {
  const router = Router();

  /**
   * GET /symptoms
   * Returns symptom logs for the authenticated user within [from, to].
   * Ordered by symptomDate desc, then createdAt asc for same-day stability.
   * Max range: 90 days.
   *
   * Query params:
   *   companyId (required)
   *   from      (required, YYYY-MM-DD)
   *   to        (required, YYYY-MM-DD)
   *   userId    (optional, defaults to actor)
   */
  router.get("/symptoms", async (req, res) => {
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
      .from(symptomLogs)
      .where(
        and(
          eq(symptomLogs.companyId, companyId),
          eq(symptomLogs.userId, userId),
          gte(symptomLogs.symptomDate, from),
          lte(symptomLogs.symptomDate, to),
        ),
      )
      .orderBy(desc(symptomLogs.symptomDate), asc(symptomLogs.createdAt));

    res.json({ from, to, logs: rows });
  });

  /**
   * POST /symptoms
   * Log a new symptom entry. Multiple symptoms per day are allowed.
   * Body: { companyId, symptomDate, symptom, severity?, notes? }
   */
  router.post("/symptoms", async (req, res) => {
    assertBoard(req);

    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const symptomDate = parseDate(body["symptomDate"]);
    if (!symptomDate) throw badRequest("symptomDate must be YYYY-MM-DD");

    const symptom =
      typeof body["symptom"] === "string" && VALID_SYMPTOMS.has(body["symptom"])
        ? body["symptom"]
        : null;
    if (!symptom)
      throw badRequest(`symptom must be one of: ${[...VALID_SYMPTOMS].join(", ")}`);

    let severity: number | null = null;
    if (body["severity"] !== undefined && body["severity"] !== null) {
      if (
        typeof body["severity"] !== "number" ||
        !Number.isInteger(body["severity"]) ||
        body["severity"] < 1 ||
        body["severity"] > 5
      ) {
        throw badRequest("severity must be an integer between 1 and 5");
      }
      severity = body["severity"];
    }

    const notes = typeof body["notes"] === "string" ? body["notes"].trim() : null;

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [row] = await db
      .insert(symptomLogs)
      .values({
        companyId,
        userId,
        symptomDate,
        symptom,
        severity: severity ?? undefined,
        notes: notes ?? undefined,
      })
      .returning();

    res.status(201).json(row);
  });

  /**
   * DELETE /symptoms/:id
   * Remove a symptom log entry by id.
   */
  router.delete("/symptoms/:id", async (req, res) => {
    assertBoard(req);
    const { id } = req.params as { id: string };

    const userId = req.actor.userId ?? null;
    if (!userId) throw badRequest("Could not resolve userId");

    const [existing] = await db.select().from(symptomLogs).where(eq(symptomLogs.id, id));
    if (!existing) throw notFound("Symptom log not found");
    assertCompanyAccess(req, existing.companyId);
    if (existing.userId !== userId) throw notFound("Symptom log not found");

    await db.delete(symptomLogs).where(eq(symptomLogs.id, id));
    res.status(204).send();
  });

  return router;
}

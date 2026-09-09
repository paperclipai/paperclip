import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { solarisAlerts, solarisOrgs } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { translateAlertForAllLocales, SUPPORTED_LOCALES } from "../services/alert-translation.js";

const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
const SUPPORTED_LANGUAGES = ["en", ...SUPPORTED_LOCALES] as const;

export function solarisAlertRoutes(db: Db) {
  const router = Router();

  // ── Orgs ────────────────────────────────────────────────────────────────────

  /** GET /solaris/orgs?companyId= */
  router.get("/solaris/orgs", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query["companyId"] === "string" ? req.query["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(solarisOrgs)
      .where(and(eq(solarisOrgs.companyId, companyId), eq(solarisOrgs.isActive, true)))
      .orderBy(solarisOrgs.name);

    res.json({ orgs: rows });
  });

  /** POST /solaris/orgs */
  router.post("/solaris/orgs", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const name = typeof body["name"] === "string" ? body["name"].trim() : null;
    if (!name) throw badRequest("name is required");

    const preferredLanguage = SUPPORTED_LANGUAGES.includes(body["preferredLanguage"] as typeof SUPPORTED_LANGUAGES[number])
      ? (body["preferredLanguage"] as string)
      : "en";

    const [row] = await db
      .insert(solarisOrgs)
      .values({
        companyId,
        name,
        preferredLanguage,
        contactEmail: typeof body["contactEmail"] === "string" ? body["contactEmail"] : null,
      })
      .returning();

    res.status(201).json(row);
  });

  /** PATCH /solaris/orgs/:orgId */
  router.patch("/solaris/orgs/:orgId", async (req, res) => {
    assertBoard(req);
    const { orgId } = req.params;

    const [existing] = await db.select().from(solarisOrgs).where(eq(solarisOrgs.id, orgId));
    if (!existing || !existing.isActive) throw notFound("Org not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const updates: Partial<typeof solarisOrgs.$inferInsert> = { updatedAt: new Date() };

    if (typeof body["name"] === "string" && body["name"].trim()) updates.name = body["name"].trim();
    if (typeof body["contactEmail"] === "string") updates.contactEmail = body["contactEmail"];
    if (SUPPORTED_LANGUAGES.includes(body["preferredLanguage"] as typeof SUPPORTED_LANGUAGES[number])) {
      updates.preferredLanguage = body["preferredLanguage"] as string;
    }

    const [updated] = await db
      .update(solarisOrgs)
      .set(updates)
      .where(eq(solarisOrgs.id, orgId))
      .returning();

    res.json(updated);
  });

  /** DELETE /solaris/orgs/:orgId (soft delete) */
  router.delete("/solaris/orgs/:orgId", async (req, res) => {
    assertBoard(req);
    const { orgId } = req.params;

    const [existing] = await db.select().from(solarisOrgs).where(eq(solarisOrgs.id, orgId));
    if (!existing || !existing.isActive) throw notFound("Org not found");
    assertCompanyAccess(req, existing.companyId);

    await db.update(solarisOrgs).set({ isActive: false, updatedAt: new Date() }).where(eq(solarisOrgs.id, orgId));
    res.status(204).end();
  });

  // ── Alerts ──────────────────────────────────────────────────────────────────

  /** GET /solaris/alerts?companyId=&orgId=&limit= */
  router.get("/solaris/alerts", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query["companyId"] === "string" ? req.query["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const orgId = typeof req.query["orgId"] === "string" ? req.query["orgId"].trim() : null;
    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10) || 50, 200);

    const conditions = [eq(solarisAlerts.companyId, companyId)];
    if (orgId) conditions.push(eq(solarisAlerts.orgId, orgId));

    const rows = await db
      .select()
      .from(solarisAlerts)
      .where(and(...conditions))
      .orderBy(desc(solarisAlerts.createdAt))
      .limit(limit);

    res.json({ alerts: rows });
  });

  /** GET /solaris/alerts/:alertId */
  router.get("/solaris/alerts/:alertId", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [row] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!row) throw notFound("Alert not found");
    assertCompanyAccess(req, row.companyId);

    res.json(row);
  });

  /** POST /solaris/alerts — creates alert and async-triggers translation */
  router.post("/solaris/alerts", async (req, res) => {
    assertBoard(req);
    const body = req.body as Record<string, unknown>;
    const companyId = typeof body["companyId"] === "string" ? body["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const title = typeof body["title"] === "string" ? body["title"].trim() : null;
    if (!title) throw badRequest("title is required");

    const alertBody = typeof body["body"] === "string" ? body["body"].trim() : null;
    if (!alertBody) throw badRequest("body is required");

    const severity = ALERT_SEVERITIES.includes(body["severity"] as typeof ALERT_SEVERITIES[number])
      ? (body["severity"] as typeof ALERT_SEVERITIES[number])
      : "info";

    const orgId = typeof body["orgId"] === "string" ? body["orgId"].trim() : null;
    let targetLocale = "en";

    if (orgId) {
      const [org] = await db.select().from(solarisOrgs).where(eq(solarisOrgs.id, orgId));
      if (org) targetLocale = org.preferredLanguage;
    }

    const userId = req.actor?.userId ?? null;

    const [alert] = await db
      .insert(solarisAlerts)
      .values({
        companyId,
        orgId: orgId ?? undefined,
        title,
        body: alertBody,
        severity,
        capIdentifier: typeof body["capIdentifier"] === "string" ? body["capIdentifier"] : null,
        incidentArea: typeof body["incidentArea"] === "string" ? body["incidentArea"] : null,
        createdBy: userId,
        dispatchStatus: targetLocale !== "en" ? "translating" : "ready",
      })
      .returning();

    // Fire-and-forget translation for non-English orgs
    if (targetLocale !== "en") {
      translateAlertForAllLocales(alert.id, alertBody, [targetLocale as typeof SUPPORTED_LOCALES[number]])
        .then((translations) => {
          if (Object.keys(translations).length > 0) {
            return db
              .update(solarisAlerts)
              .set({ translatedBodies: translations, dispatchStatus: "ready", updatedAt: new Date() })
              .where(eq(solarisAlerts.id, alert.id));
          }
          return db
            .update(solarisAlerts)
            .set({ dispatchStatus: "failed", updatedAt: new Date() })
            .where(eq(solarisAlerts.id, alert.id));
        })
        .catch((err) => {
          console.error(`Alert translation background job failed for ${alert.id}:`, err);
          db.update(solarisAlerts)
            .set({ dispatchStatus: "failed", updatedAt: new Date() })
            .where(eq(solarisAlerts.id, alert.id))
            .catch(() => {});
        });
    }

    res.status(201).json(alert);
  });

  /** PATCH /solaris/alerts/:alertId — manual status / body update */
  router.patch("/solaris/alerts/:alertId", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const updates: Partial<typeof solarisAlerts.$inferInsert> = { updatedAt: new Date() };

    if (typeof body["title"] === "string" && body["title"].trim()) updates.title = body["title"].trim();
    if (typeof body["body"] === "string" && body["body"].trim()) updates.body = body["body"].trim();
    if (ALERT_SEVERITIES.includes(body["severity"] as typeof ALERT_SEVERITIES[number])) {
      updates.severity = body["severity"] as typeof ALERT_SEVERITIES[number];
    }

    const [updated] = await db
      .update(solarisAlerts)
      .set(updates)
      .where(eq(solarisAlerts.id, alertId))
      .returning();

    res.json(updated);
  });

  return router;
}

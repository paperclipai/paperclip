import { Router } from "express";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  alertNotes,
  incidentActivityLog,
  incidentChatMessages,
  responderStatusUpdates,
  webPushSubscriptions,
  solarisAlerts,
  solarisOrgs,
  companyMemberships,
  authUsers,
} from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, notFound } from "../errors.js";
import { translateAlertForAllLocales, SUPPORTED_LOCALES } from "../services/alert-translation.js";
import { publishLiveEvent } from "../services/live-events.js";

const RESPONDER_STATUSES = ["acknowledged", "en_route", "on_scene", "cleared"] as const;
type ResponderStatus = (typeof RESPONDER_STATUSES)[number];

const ALERT_SEVERITIES = ["critical", "warning", "info"] as const;
const SUPPORTED_LANGUAGES = ["en", ...SUPPORTED_LOCALES] as const;

function logActivity(
  db: Db,
  opts: {
    alertId: string;
    companyId: string;
    eventType: string;
    actorId?: string | null;
    actorName?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  return db.insert(incidentActivityLog).values({
    alertId: opts.alertId,
    companyId: opts.companyId,
    eventType: opts.eventType,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    metadata: opts.metadata ?? null,
  });
}

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

    await logActivity(db, {
      alertId: alert.id,
      companyId,
      eventType: "alert.created",
      actorId: userId,
      metadata: { title, severity },
    });

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
    const severityChanged = ALERT_SEVERITIES.includes(body["severity"] as typeof ALERT_SEVERITIES[number]);
    if (severityChanged) {
      updates.severity = body["severity"] as typeof ALERT_SEVERITIES[number];
    }

    const [updated] = await db
      .update(solarisAlerts)
      .set(updates)
      .where(eq(solarisAlerts.id, alertId))
      .returning();

    if (severityChanged && updates.severity !== existing.severity) {
      await logActivity(db, {
        alertId,
        companyId: existing.companyId,
        eventType: "alert.severity_changed",
        actorId: req.actor?.userId ?? null,
        metadata: { from: existing.severity, to: updates.severity },
      });
    }

    res.json(updated);
  });

  /** POST /solaris/alerts/:alertId/assign — assign alert to a responder */
  router.post("/solaris/alerts/:alertId/assign", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const assigneeId = typeof body["assigneeId"] === "string" ? body["assigneeId"].trim() : null;
    const assigneeName = typeof body["assigneeName"] === "string" ? body["assigneeName"].trim() : null;

    const [updated] = await db
      .update(solarisAlerts)
      .set({ assigneeId, assigneeName, updatedAt: new Date() })
      .where(eq(solarisAlerts.id, alertId))
      .returning();

    await logActivity(db, {
      alertId,
      companyId: existing.companyId,
      eventType: "alert.assigned",
      actorId: req.actor?.userId ?? null,
      metadata: { assigneeId, assigneeName },
    });

    publishLiveEvent({
      companyId: existing.companyId,
      type: "solaris.alert.updated",
      payload: { alertId, assigneeId, assigneeName },
    });

    res.json(updated);
  });

  /** POST /solaris/alerts/:alertId/handoff — reassign to another dispatcher with a mandatory note */
  router.post("/solaris/alerts/:alertId/handoff", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const assigneeId = typeof body["assigneeId"] === "string" ? body["assigneeId"].trim() : null;
    const assigneeName = typeof body["assigneeName"] === "string" ? body["assigneeName"].trim() : null;
    const note = typeof body["note"] === "string" ? body["note"].trim() : null;
    if (!note) throw badRequest("note is required for handoff");

    const actorId = req.actor?.userId ?? null;
    const actorName = typeof body["actorName"] === "string" ? body["actorName"].trim() : null;

    const [updated] = await db
      .update(solarisAlerts)
      .set({ assigneeId, assigneeName, updatedAt: new Date() })
      .where(eq(solarisAlerts.id, alertId))
      .returning();

    const [handoffNote] = await db
      .insert(alertNotes)
      .values({
        alertId,
        companyId: existing.companyId,
        body: `[HANDOFF] ${note}`,
        authorId: actorId,
        authorName: actorName,
      })
      .returning();

    await logActivity(db, {
      alertId,
      companyId: existing.companyId,
      eventType: "alert.reassigned",
      actorId,
      actorName,
      metadata: {
        fromAssigneeId: existing.assigneeId,
        fromAssigneeName: existing.assigneeName,
        toAssigneeId: assigneeId,
        toAssigneeName: assigneeName,
        noteId: handoffNote.id,
      },
    });

    publishLiveEvent({
      companyId: existing.companyId,
      type: "solaris.alert.updated",
      payload: { alertId, assigneeId, assigneeName, handoff: true },
    });

    res.json({ alert: updated, note: handoffNote });
  });

  /** POST /solaris/alerts/:alertId/notes — add a note to an alert */
  router.post("/solaris/alerts/:alertId/notes", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const noteBody = typeof body["body"] === "string" ? body["body"].trim() : null;
    if (!noteBody) throw badRequest("body is required");

    const actorId = req.actor?.userId ?? null;
    const authorName = typeof body["authorName"] === "string" ? body["authorName"].trim() : null;

    const [note] = await db
      .insert(alertNotes)
      .values({
        alertId,
        companyId: existing.companyId,
        body: noteBody,
        authorId: actorId,
        authorName,
      })
      .returning();

    await logActivity(db, {
      alertId,
      companyId: existing.companyId,
      eventType: "alert.note_added",
      actorId,
      actorName: authorName,
      metadata: { noteId: note.id },
    });

    res.status(201).json(note);
  });

  /** GET /solaris/alerts/:alertId/notes — list notes for an alert */
  router.get("/solaris/alerts/:alertId/notes", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const notes = await db
      .select()
      .from(alertNotes)
      .where(eq(alertNotes.alertId, alertId))
      .orderBy(asc(alertNotes.createdAt));

    res.json({ notes });
  });

  // ── Chat ─────────────────────────────────────────────────────────────────────

  /** POST /solaris/alerts/:alertId/chat — send a chat message */
  router.post("/solaris/alerts/:alertId/chat", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const msgBody = typeof body["body"] === "string" ? body["body"].trim() : null;
    if (!msgBody) throw badRequest("body is required");

    const actorId = req.actor?.userId ?? null;
    const authorName = typeof body["authorName"] === "string" ? body["authorName"].trim() : null;

    const [message] = await db
      .insert(incidentChatMessages)
      .values({
        alertId,
        companyId: existing.companyId,
        body: msgBody,
        authorId: actorId,
        authorName,
      })
      .returning();

    publishLiveEvent({
      companyId: existing.companyId,
      type: "solaris.alert.chat",
      payload: { alertId, message },
    });

    res.status(201).json(message);
  });

  /** GET /solaris/alerts/:alertId/chat?limit=&before= — list chat messages */
  router.get("/solaris/alerts/:alertId/chat", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const limit = Math.min(parseInt(String(req.query["limit"] ?? "100"), 10) || 100, 500);
    const before = typeof req.query["before"] === "string" ? new Date(req.query["before"]) : null;

    const conditions = [eq(incidentChatMessages.alertId, alertId)];
    if (before && !isNaN(before.getTime())) {
      conditions.push(lt(incidentChatMessages.createdAt, before));
    }

    const messages = await db
      .select()
      .from(incidentChatMessages)
      .where(and(...conditions))
      .orderBy(asc(incidentChatMessages.createdAt))
      .limit(limit);

    const nextBefore = messages.length === limit ? messages[0]?.createdAt?.toISOString() ?? null : null;

    res.json({ messages, nextBefore });
  });

  // ── Activity Log ─────────────────────────────────────────────────────────────

  /** GET /solaris/alerts/:alertId/activity?limit= — immutable event log */
  router.get("/solaris/alerts/:alertId/activity", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const limit = Math.min(parseInt(String(req.query["limit"] ?? "100"), 10) || 100, 500);

    const events = await db
      .select()
      .from(incidentActivityLog)
      .where(eq(incidentActivityLog.alertId, alertId))
      .orderBy(asc(incidentActivityLog.createdAt))
      .limit(limit);

    res.json({ events });
  });

  // ── Team ─────────────────────────────────────────────────────────────────────

  /** GET /solaris/team/members?companyId= — return active users for Assign dropdown */
  router.get("/solaris/team/members", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query["companyId"] === "string" ? req.query["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );

    res.json({ members: rows });
  });

  // ── Responder Status ─────────────────────────────────────────────────────────

  /** POST /solaris/alerts/:alertId/responder-status — advance responder status */
  router.post("/solaris/alerts/:alertId/responder-status", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const body = req.body as Record<string, unknown>;
    const status = typeof body["status"] === "string" ? body["status"].trim() : null;
    if (!status || !(RESPONDER_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(`status must be one of: ${RESPONDER_STATUSES.join(", ")}`);
    }

    const actor = getActorInfo(req);
    const responderId = typeof body["responderId"] === "string" ? body["responderId"].trim() : actor.actorId;
    const responderName = typeof body["responderName"] === "string" ? body["responderName"].trim() : null;
    const note = typeof body["note"] === "string" ? body["note"].trim() : null;

    const [update] = await db
      .insert(responderStatusUpdates)
      .values({
        alertId,
        companyId: existing.companyId,
        status: status as ResponderStatus,
        responderId,
        responderName,
        note: note || null,
      })
      .returning();

    publishLiveEvent({
      companyId: existing.companyId,
      type: "solaris.alert.responder_status",
      payload: { alertId, update },
    });

    res.status(201).json(update);
  });

  /** GET /solaris/alerts/:alertId/responder-status?responderId=&limit= — status history */
  router.get("/solaris/alerts/:alertId/responder-status", async (req, res) => {
    assertBoard(req);
    const { alertId } = req.params;

    const [existing] = await db.select().from(solarisAlerts).where(eq(solarisAlerts.id, alertId));
    if (!existing) throw notFound("Alert not found");
    assertCompanyAccess(req, existing.companyId);

    const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10) || 50, 200);
    const responderId = typeof req.query["responderId"] === "string" ? req.query["responderId"].trim() : null;

    const conditions = [eq(responderStatusUpdates.alertId, alertId)];
    if (responderId) conditions.push(eq(responderStatusUpdates.responderId, responderId));

    const updates = await db
      .select()
      .from(responderStatusUpdates)
      .where(and(...conditions))
      .orderBy(asc(responderStatusUpdates.createdAt))
      .limit(limit);

    const latest = updates.length > 0 ? updates[updates.length - 1] : null;
    res.json({ updates, latestStatus: latest?.status ?? null });
  });

  // ── Web Push Subscriptions ───────────────────────────────────────────────────

  /** POST /solaris/push/subscribe?companyId= — register a VAPID push subscription */
  router.post("/solaris/push/subscribe", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query["companyId"] === "string" ? req.query["companyId"].trim() : null;
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);

    const body = req.body as Record<string, unknown>;
    const endpoint = typeof body["endpoint"] === "string" ? body["endpoint"].trim() : null;
    const p256dh = typeof body["p256dh"] === "string" ? body["p256dh"].trim() : null;
    const auth = typeof body["auth"] === "string" ? body["auth"].trim() : null;
    const responderId = typeof body["responderId"] === "string" ? body["responderId"].trim() : null;

    if (!endpoint || !p256dh || !auth || !responderId) {
      throw badRequest("endpoint, p256dh, auth, and responderId are required");
    }

    const [existing] = await db
      .select()
      .from(webPushSubscriptions)
      .where(and(eq(webPushSubscriptions.responderId, responderId), eq(webPushSubscriptions.endpoint, endpoint)));

    if (existing) {
      const [updated] = await db
        .update(webPushSubscriptions)
        .set({ p256dh, auth, updatedAt: new Date() })
        .where(eq(webPushSubscriptions.id, existing.id))
        .returning();
      return res.json(updated);
    }

    const [sub] = await db
      .insert(webPushSubscriptions)
      .values({ companyId, responderId, endpoint, p256dh, auth })
      .returning();

    res.status(201).json(sub);
  });

  /** DELETE /solaris/push/subscribe/:subscriptionId — remove a push subscription */
  router.delete("/solaris/push/subscribe/:subscriptionId", async (req, res) => {
    assertBoard(req);
    const { subscriptionId } = req.params;

    const [sub] = await db
      .select()
      .from(webPushSubscriptions)
      .where(eq(webPushSubscriptions.id, subscriptionId));
    if (!sub) throw notFound("Subscription not found");
    assertCompanyAccess(req, sub.companyId);

    await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.id, subscriptionId));
    res.status(204).end();
  });

  /** GET /solaris/push/vapid-public-key — serve the VAPID public key for client subscription */
  router.get("/solaris/push/vapid-public-key", async (req, res) => {
    assertBoard(req);
    const vapidPublicKey = process.env["VAPID_PUBLIC_KEY"] ?? null;
    res.json({ vapidPublicKey });
  });

  return router;
}

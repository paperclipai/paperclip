import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { createRequire } from "node:module";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  boardBriefAlertEvents,
  boardBriefSnapshots,
  companies,
  companyMemberships,
} from "@paperclipai/db";
import type { BoardBrief, BoardBriefAlertEvent, BoardBriefIncident } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { boardBriefService } from "./board-brief.js";

type MailSender = {
  sendMail(input: {
    to: string[];
    replyTo?: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value: string, max = 500) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

async function importNodemailer() {
  const require = createRequire(import.meta.url);
  return require("nodemailer");
}

async function createSmtpSenderFromEnv(): Promise<MailSender | null> {
  const host = process.env.PAPERCLIP_SMTP_HOST?.trim();
  const from = process.env.PAPERCLIP_SMTP_FROM?.trim();
  if (!host || !from) return null;

  const portRaw = process.env.PAPERCLIP_SMTP_PORT?.trim();
  const secureRaw = process.env.PAPERCLIP_SMTP_SECURE?.trim().toLowerCase();
  const user = process.env.PAPERCLIP_SMTP_USER?.trim();
  const pass = process.env.PAPERCLIP_SMTP_PASS?.trim();
  const port = portRaw ? Number(portRaw) : 587;
  const secure = secureRaw === "true" || secureRaw === "1";
  const replyTo = process.env.PAPERCLIP_SMTP_REPLY_TO?.trim() || undefined;

  const nodemailer = await importNodemailer();
  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });

  return {
    sendMail: async ({ to, subject, text, html }) => {
      await transporter.sendMail({
        from,
        to,
        replyTo,
        subject,
        text,
        html,
      });
    },
  };
}

function renderCriticalAlertText(companyName: string, brief: BoardBrief, incident: BoardBriefIncident): string {
  const lines: string[] = [];
  lines.push(`${companyName} — Critical Board Alert`);
  lines.push(`Generated: ${brief.meta.generatedAt.toLocaleString()}`);
  lines.push("");
  lines.push(`Alert: ${incident.title}`);
  lines.push(`Reason: ${incident.reason}`);
  lines.push(`Severity: ${incident.severity}`);
  lines.push("");
  lines.push(`Health: ${brief.health.tone}`);
  for (const reason of brief.health.reasons.slice(0, 3)) {
    lines.push(`- ${reason}`);
  }
  lines.push("");
  lines.push("Top Actions");
  if (brief.actionQueue.length === 0) {
    lines.push("- No action items queued.");
  } else {
    for (const action of brief.actionQueue.slice(0, 5)) {
      lines.push(`- [${action.severity}] ${action.title}: ${action.reason}`);
    }
  }
  return lines.join("\n");
}

function renderCriticalAlertHtml(companyName: string, brief: BoardBrief, incident: BoardBriefIncident): string {
  const healthReasons = brief.health.reasons.length === 0
    ? "<li>No additional health reasons.</li>"
    : brief.health.reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");
  const actions = brief.actionQueue.length === 0
    ? "<li>No action items queued.</li>"
    : brief.actionQueue.slice(0, 5)
      .map((action) => `<li><strong>[${escapeHtml(action.severity)}]</strong> ${escapeHtml(action.title)}: ${escapeHtml(action.reason)}</li>`)
      .join("");

  return `
<div style="font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; line-height: 1.45;">
  <h2 style="margin: 0 0 8px;">${escapeHtml(companyName)} — Critical Board Alert</h2>
  <p style="margin: 0 0 16px; color: #6b7280;">Generated ${escapeHtml(brief.meta.generatedAt.toLocaleString())}</p>
  <p style="margin: 0 0 8px;"><strong>${escapeHtml(incident.title)}</strong></p>
  <p style="margin: 0 0 8px;">${escapeHtml(incident.reason)}</p>
  <p style="margin: 0 0 16px;">Severity: <strong>${escapeHtml(incident.severity)}</strong></p>
  <h3 style="margin: 16px 0 8px;">Health</h3>
  <p style="margin: 0 0 8px;"><strong>${escapeHtml(brief.health.tone)}</strong></p>
  <ul style="margin-top: 0;">${healthReasons}</ul>
  <h3 style="margin: 16px 0 8px;">Top Actions</h3>
  <ul style="margin-top: 0;">${actions}</ul>
</div>
`.trim();
}

async function resolveRecipientEmails(companyId: string, database: Db | any): Promise<string[]> {
  const rows = await database
    .select({ email: authUsers.email })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        isNotNull(authUsers.email),
      ),
    );

  const deduped = new Map<string, string>();
  for (const row of rows) {
    const email = row.email.trim();
    if (!email) continue;
    deduped.set(email.toLowerCase(), email);
  }
  return [...deduped.values()];
}

export function boardBriefDeliveryService(
  db: Db,
  options: {
    sender?: MailSender | null;
  } = {},
) {
  const serviceLogger = logger.child({ service: "board-brief-delivery" });
  const briefs = boardBriefService(db);
  let senderPromise: Promise<MailSender | null> | null = null;
  let tickInProgress = false;

  async function getSender() {
    if (options.sender !== undefined) return options.sender;
    if (!senderPromise) {
      senderPromise = createSmtpSenderFromEnv().catch((err) => {
        serviceLogger.error({ err }, "failed to initialize board brief SMTP sender");
        return null;
      });
    }
    return senderPromise;
  }

  async function persistSnapshot(
    brief: BoardBrief,
    source: BoardBriefAlertEvent["status"] extends never ? never : "daily_digest" | "critical_alert" | "manual",
    database: Db | any = db,
    relatedAlertEventId: string | null = null,
  ) {
    return database
      .insert(boardBriefSnapshots)
      .values({
        companyId: brief.meta.companyId,
        source,
        schemaVersion: brief.meta.schemaVersion,
        health: brief.health.tone,
        confidence: brief.confidence,
        windowStart: brief.meta.windowStart,
        windowEnd: brief.meta.windowEnd,
        generatedAt: brief.meta.generatedAt,
        relatedAlertEventId,
        payload: brief as unknown as Record<string, unknown>,
      })
      .returning()
      .then((rows: Array<typeof boardBriefSnapshots.$inferSelect>) => rows[0] ?? null);
  }

  async function persistCompanySnapshot(
    companyId: string,
    source: "daily_digest" | "critical_alert" | "manual",
    now: Date,
    database: Db | any = db,
    relatedAlertEventId: string | null = null,
  ) {
    const brief = await briefs.build(companyId, now, database);
    return persistSnapshot(brief, source, database, relatedAlertEventId);
  }

  async function tickCriticalAlerts(now: Date = new Date()) {
    if (tickInProgress) {
      return {
        processed: 0,
        sent: 0,
        resolved: 0,
        active: 0,
      };
    }

    tickInProgress = true;
    try {
      const sender = await getSender();
      const companyRows = await db
        .select({
          id: companies.id,
          name: companies.name,
          criticalBoardAlertsEmailEnabled: companies.criticalBoardAlertsEmailEnabled,
        })
        .from(companies)
        .where(eq(companies.criticalBoardAlertsEmailEnabled, true));

      let sent = 0;
      let resolved = 0;
      let active = 0;

      for (const company of companyRows) {
        await db.transaction(async (tx) => {
          const brief = await briefs.build(company.id, now, tx as unknown as Db);
          const recipients = await resolveRecipientEmails(company.id, tx as unknown as Db);
          const currentIncidents = brief.incidents.filter((incident) => incident.shouldAlert);
          const byFingerprint = new Map(currentIncidents.map((incident) => [incident.fingerprint, incident]));

          const existingRows = await tx
            .select()
            .from(boardBriefAlertEvents)
            .where(eq(boardBriefAlertEvents.companyId, company.id));
          const existingByFingerprint = new Map(existingRows.map((row) => [row.fingerprint, row]));

          for (const row of existingRows) {
            if (row.status !== "active" || byFingerprint.has(row.fingerprint)) continue;
            await tx
              .update(boardBriefAlertEvents)
              .set({
                status: "resolved",
                lastDetectedAt: now,
                updatedAt: now,
              })
              .where(eq(boardBriefAlertEvents.id, row.id));
            resolved += 1;
          }

          for (const incident of currentIncidents) {
            const existing = existingByFingerprint.get(incident.fingerprint);
            const shouldSend =
              !existing
              || existing.status === "resolved"
              || (!existing.firstSentAt && existing.status === "active");

            let eventId = existing?.id ?? null;
            if (!existing) {
              const inserted = await tx
                .insert(boardBriefAlertEvents)
                .values({
                  companyId: company.id,
                  fingerprint: incident.fingerprint,
                  incidentType: incident.type,
                  severity: incident.severity,
                  entityType: incident.entityType,
                  entityId: incident.entityId,
                  status: "active",
                  firstDetectedAt: incident.openedAt,
                  lastDetectedAt: incident.lastSeenAt,
                })
                .returning()
                .then((rows: Array<typeof boardBriefAlertEvents.$inferSelect>) => rows[0] ?? null);
              eventId = inserted?.id ?? null;
            } else {
              await tx
                .update(boardBriefAlertEvents)
                .set({
                  incidentType: incident.type,
                  severity: incident.severity,
                  entityType: incident.entityType,
                  entityId: incident.entityId,
                  status: "active",
                  firstDetectedAt: existing.status === "resolved" ? incident.openedAt : existing.firstDetectedAt,
                  lastDetectedAt: incident.lastSeenAt,
                  updatedAt: now,
                })
                .where(eq(boardBriefAlertEvents.id, existing.id));
            }

            active += 1;

            if (!shouldSend || !sender || recipients.length === 0 || !eventId) continue;

            const snapshot = await persistSnapshot(brief, "critical_alert", tx as unknown as Db, eventId);
            await sender.sendMail({
              to: recipients,
              subject: `${company.name} · Critical Board Alert · ${incident.title}`,
              text: renderCriticalAlertText(company.name, brief, incident),
              html: renderCriticalAlertHtml(company.name, brief, incident),
            });
            await tx
              .update(boardBriefAlertEvents)
              .set({
                firstSentAt: existing?.firstSentAt ?? now,
                lastSentAt: now,
                lastSnapshotId: snapshot?.id ?? null,
                updatedAt: now,
              })
              .where(eq(boardBriefAlertEvents.id, eventId));
            sent += 1;
          }
        });
      }

      return {
        processed: companyRows.length,
        sent,
        resolved,
        active,
      };
    } finally {
      tickInProgress = false;
    }
  }

  return {
    persistSnapshot,
    persistCompanySnapshot,
    tickCriticalAlerts,
  };
}

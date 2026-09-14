import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq, lt, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agencyWebhookConfigs, cadWebhookDlq, solarisAlerts } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import { notFound } from "../errors.js";

const SIGNATURE_HEADER = "x-cad-signature";
const AGENCY_CODE_HEADER = "x-cad-agency-code";

const MAX_DLQ_RETRIES = 3;
// Exponential backoff: attempt 1 → 30s, 2 → 60s, 3 → 120s
const BACKOFF_SECONDS = [30, 60, 120] as const;

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

function verifyHmac(secret: string, rawBody: Buffer, providedSig: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const normalised = providedSig.replace(/^sha256=/, "");
  if (normalised.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(normalised), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Normalized payload type
// ---------------------------------------------------------------------------

type NormalizedPayload = {
  incidentId: string | null;
  incidentName: string | null;
  incidentType: string | null;
  lat: number | null;
  lon: number | null;
  reportedAt: Date | null;
  agencyCode: string | null;
  vendor: string;
};

// ---------------------------------------------------------------------------
// XML helper: strips namespace prefix (e.g. "pm:Latitude" → "Latitude") and
// collects leaf-text values.
// ---------------------------------------------------------------------------

function parseXmlFields(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<(?:[A-Za-z][A-Za-z0-9_]*:)?([A-Za-z][A-Za-z0-9_]*)>([^<]*)<\/(?:[A-Za-z][A-Za-z0-9_]*:)?\1>/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

function parseFloat2(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseDate(v: string | undefined | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Vendor adapters
// ---------------------------------------------------------------------------

function adaptTritech(json: Record<string, unknown>): NormalizedPayload {
  // TriTech CAD JSON uses CallNumber, NatureOfCall, CallType, Latitude/Longitude, CallEnteredDateTime
  const lat = typeof json["Latitude"] === "number" ? json["Latitude"] : parseFloat2(String(json["Latitude"] ?? ""));
  const lon = typeof json["Longitude"] === "number" ? json["Longitude"] : parseFloat2(String(json["Longitude"] ?? ""));
  const ts = (json["CallEnteredDateTime"] ?? json["CallDateTime"] ?? null) as string | null;
  return {
    incidentId:   (json["CallNumber"] as string | undefined) ?? null,
    incidentName: (json["NatureOfCall"] as string | undefined) ?? null,
    incidentType: (json["CallType"] as string | undefined) ?? null,
    lat,
    lon,
    reportedAt:   parseDate(ts),
    agencyCode:   (json["Agency"] as string | undefined) ?? (json["AgencyCode"] as string | undefined) ?? null,
    vendor: "tritech",
  };
}

function adaptMotorolaPremierOne(fields: Record<string, string>): NormalizedPayload {
  // Motorola PremierOne XML: IncidentNumber, NatureOfCall, IncidentCategory,
  // Latitude/Longitude, CallReceivedDateTime, AgencyCode
  return {
    incidentId:   fields["IncidentNumber"] ?? null,
    incidentName: fields["NatureOfCall"] ?? null,
    incidentType: fields["IncidentCategory"] ?? fields["IncidentType"] ?? null,
    lat:          parseFloat2(fields["Latitude"]),
    lon:          parseFloat2(fields["Longitude"]),
    reportedAt:   parseDate(fields["CallReceivedDateTime"] ?? fields["ReportedDateTime"] ?? null),
    agencyCode:   fields["AgencyCode"] ?? null,
    vendor: "motorola",
  };
}

function adaptGenericJson(json: Record<string, unknown>): NormalizedPayload {
  const lat = typeof json["lat"] === "number" ? json["lat"] : parseFloat2(String(json["lat"] ?? ""));
  const lon = typeof json["lon"] === "number" ? json["lon"] : parseFloat2(String(json["lon"] ?? ""));
  return {
    incidentId:   typeof json["incident_id"] === "string" ? json["incident_id"] : null,
    incidentName: typeof json["incident_name"] === "string" ? json["incident_name"] : null,
    incidentType: typeof json["incident_type"] === "string" ? json["incident_type"] : null,
    lat,
    lon,
    reportedAt:   parseDate(typeof json["reported_at"] === "string" ? json["reported_at"] : null),
    agencyCode:   typeof json["agency_code"] === "string" ? json["agency_code"] : null,
    vendor: "generic",
  };
}

function adaptGenericXml(fields: Record<string, string>): NormalizedPayload {
  return {
    incidentId:   fields["IncidentId"] ?? fields["incident_id"] ?? null,
    incidentName: fields["IncidentName"] ?? fields["incident_name"] ?? fields["CallType"] ?? null,
    incidentType: fields["IncidentType"] ?? fields["incident_type"] ?? null,
    lat:          parseFloat2(fields["Latitude"] ?? fields["lat"]),
    lon:          parseFloat2(fields["Longitude"] ?? fields["lon"]),
    reportedAt:   parseDate(fields["CallDateTime"] ?? fields["reported_at"] ?? fields["Timestamp"] ?? null),
    agencyCode:   fields["AgencyCode"] ?? fields["agency_code"] ?? null,
    vendor: "generic_xml",
  };
}

// ---------------------------------------------------------------------------
// Auto-detection + normalization
// ---------------------------------------------------------------------------

function normalizePayload(contentType: string, rawBody: Buffer): NormalizedPayload {
  const isXml = contentType.includes("xml");

  if (isXml) {
    const text = rawBody.toString("utf-8");
    const isMotorolaXml = /PremierOne|premierone|motorola/i.test(text);
    const fields = parseXmlFields(text);
    if (isMotorolaXml) {
      return adaptMotorolaPremierOne(fields);
    }
    return adaptGenericXml(fields);
  }

  const json = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
  // TriTech detection: uses CallNumber (not incident_id) and NatureOfCall
  const isTritechJson = ("CallNumber" in json) || ("NatureOfCall" in json && "CallType" in json && !("incident_id" in json));
  if (isTritechJson) {
    return adaptTritech(json);
  }
  return adaptGenericJson(json);
}

// ---------------------------------------------------------------------------
// DLQ helpers
// ---------------------------------------------------------------------------

type DlqEntry = {
  id: string;
  attemptCount: number;
  status: "pending" | "exhausted" | "replayed";
  nextRetryAt: Date | null;
};

async function findActiveDlqEntry(db: Db, agencyCode: string, incidentId: string | null): Promise<DlqEntry | null> {
  if (!incidentId) return null;
  const rows = await db
    .select({
      id: cadWebhookDlq.id,
      attemptCount: cadWebhookDlq.attemptCount,
      status: cadWebhookDlq.status,
      nextRetryAt: cadWebhookDlq.nextRetryAt,
    })
    .from(cadWebhookDlq)
    .where(
      and(
        eq(cadWebhookDlq.agencyCode, agencyCode),
        eq(cadWebhookDlq.incidentId, incidentId),
        or(eq(cadWebhookDlq.status, "pending"), eq(cadWebhookDlq.status, "exhausted")),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function writeDlqEntry(
  db: Db,
  opts: {
    companyId: string | null;
    agencyCode: string;
    incidentId: string | null;
    rawPayload: string;
    contentType: string;
    vendor: string;
    errorReason: string;
    attemptCount: number;
    status: "pending" | "exhausted";
    nextRetryAt: Date | null;
  },
): Promise<void> {
  await db.insert(cadWebhookDlq).values({
    companyId: opts.companyId ?? undefined,
    agencyCode: opts.agencyCode,
    incidentId: opts.incidentId,
    rawPayload: opts.rawPayload,
    contentType: opts.contentType,
    vendor: opts.vendor,
    errorReason: opts.errorReason,
    attemptCount: opts.attemptCount,
    status: opts.status,
    nextRetryAt: opts.nextRetryAt,
  });
}

async function incrementDlqEntry(db: Db, id: string, attemptCount: number, nextRetryAt: Date | null, exhausted: boolean): Promise<void> {
  await db
    .update(cadWebhookDlq)
    .set({
      attemptCount,
      nextRetryAt: exhausted ? null : nextRetryAt,
      status: exhausted ? "exhausted" : "pending",
      updatedAt: new Date(),
    })
    .where(eq(cadWebhookDlq.id, id));
}

// Returns how to respond: 'retry' = return 500 (more retries allowed),
// 'exhausted' = return 202 (max retries reached, entry already in DLQ)
async function handleTransientFailure(
  db: Db,
  opts: {
    companyId: string | null;
    agencyCode: string;
    incidentId: string | null;
    rawPayload: string;
    contentType: string;
    vendor: string;
    errorReason: string;
  },
): Promise<"retry" | "exhausted"> {
  const existing = await findActiveDlqEntry(db, opts.agencyCode, opts.incidentId);

  if (!existing) {
    // First failure — write DLQ entry with attempt_count=1, return 500 for retry
    const nextRetryAt = new Date(Date.now() + BACKOFF_SECONDS[0] * 1000);
    await writeDlqEntry(db, { ...opts, attemptCount: 1, status: "pending", nextRetryAt });
    return "retry";
  }

  if (existing.status === "exhausted") {
    return "exhausted";
  }

  const newCount = existing.attemptCount + 1;
  if (newCount >= MAX_DLQ_RETRIES) {
    await incrementDlqEntry(db, existing.id, newCount, null, true);
    return "exhausted";
  }

  const backoffMs = (BACKOFF_SECONDS[Math.min(newCount - 1, BACKOFF_SECONDS.length - 1)] ?? 120) * 1000;
  const nextRetryAt = new Date(Date.now() + backoffMs);
  await incrementDlqEntry(db, existing.id, newCount, nextRetryAt, false);
  return "retry";
}

// ---------------------------------------------------------------------------
// Ingest logic (shared between webhook endpoint and admin replay)
// ---------------------------------------------------------------------------

async function ingestPayload(
  db: Db,
  config: { companyId: string; agencyCode: string },
  payload: NormalizedPayload,
): Promise<{ id: string; createdAt: Date; updatedAt: Date }> {
  const title = payload.incidentName ?? payload.incidentType ?? `CAD Dispatch — ${config.agencyCode}`;
  const geoText =
    payload.lat != null && payload.lon != null
      ? `${payload.lat.toFixed(6)},${payload.lon.toFixed(6)}`
      : null;

  const [row] = await db
    .insert(solarisAlerts)
    .values({
      companyId: config.companyId,
      title,
      body: title,
      severity: "info",
      source: "CAD",
      incidentId: payload.incidentId,
      incidentName: payload.incidentName ?? null,
      incidentType: payload.incidentType ?? null,
      reportedAt: payload.reportedAt ?? null,
      incidentArea: geoText,
      createdBy: config.agencyCode,
      dispatchStatus: "ready",
    })
    .onConflictDoUpdate({
      target: solarisAlerts.incidentId,
      set: {
        title,
        body: title,
        incidentName: payload.incidentName ?? null,
        incidentType: payload.incidentType ?? null,
        reportedAt: payload.reportedAt ?? null,
        incidentArea: geoText,
        updatedAt: new Date(),
      },
    })
    .returning({ id: solarisAlerts.id, createdAt: solarisAlerts.createdAt, updatedAt: solarisAlerts.updatedAt });

  return row;
}

// ---------------------------------------------------------------------------
// Inbound webhook routes (mounted before actorMiddleware)
// ---------------------------------------------------------------------------

export function cadWebhookRoutes(db: Db) {
  const router = Router();

  // POST /api/cad/webhook
  // Mounted BEFORE actorMiddleware — CAD systems authenticate via HMAC, not user sessions.
  router.post(
    "/api/cad/webhook",
    (req, _res, next) => {
      const ct = req.headers["content-type"] ?? "";
      if (!ct.includes("json")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          (req as unknown as { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
          next();
        });
        req.on("error", next);
      } else {
        next();
      }
    },
    async (req, res) => {
      const rawBody: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!rawBody || rawBody.length === 0) {
        res.status(400).json({ error: "Empty body" });
        return;
      }

      const providedSig = (req.headers[SIGNATURE_HEADER] as string | undefined)?.trim() ?? "";
      const agencyCodeHeader = (req.headers[AGENCY_CODE_HEADER] as string | undefined)?.trim() ?? "";
      const contentType = req.headers["content-type"] ?? "application/json";

      let payload: NormalizedPayload;
      try {
        payload = normalizePayload(contentType, rawBody);
      } catch {
        res.status(400).json({ error: "Unparseable payload" });
        return;
      }

      const agencyCode = agencyCodeHeader || payload.agencyCode || null;
      if (!agencyCode) {
        res.status(400).json({ error: "Missing agency code" });
        return;
      }

      if (!payload.incidentId) {
        res.status(400).json({ error: "incident_id is required" });
        return;
      }

      const [config] = await db
        .select()
        .from(agencyWebhookConfigs)
        .where(and(eq(agencyWebhookConfigs.agencyCode, agencyCode), eq(agencyWebhookConfigs.isActive, true)))
        .limit(1);

      if (!config) {
        res.status(401).json({ error: "Unknown agency" });
        return;
      }

      if (!providedSig || !verifyHmac(config.webhookSecret, rawBody, providedSig)) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      // Override agencyCode from authenticated config
      payload.agencyCode = config.agencyCode;

      let row: { id: string; createdAt: Date; updatedAt: Date };
      try {
        row = await ingestPayload(db, { companyId: config.companyId, agencyCode: config.agencyCode }, payload);
      } catch (err) {
        // Transient failure — track in DLQ with exponential backoff
        const dlqOpts = {
          companyId: config.companyId,
          agencyCode: config.agencyCode,
          incidentId: payload.incidentId,
          rawPayload: rawBody.toString("utf-8"),
          contentType,
          vendor: payload.vendor,
          errorReason: err instanceof Error ? err.message : String(err),
        };
        const outcome = await handleTransientFailure(db, dlqOpts).catch(() => "retry" as const);
        if (outcome === "exhausted") {
          // All retries exhausted — acknowledge so CAD stops sending
          res.status(202).json({ accepted: true, exhausted: true, incidentId: payload.incidentId });
        } else {
          res.status(500).json({ error: "Ingestion error, will retry" });
        }
        return;
      }

      const isNew = row.createdAt.getTime() === row.updatedAt.getTime();
      res.status(isNew ? 201 : 200).json({
        alertId: row.id,
        created: isNew,
        incidentId: payload.incidentId,
        vendor: payload.vendor,
      });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Admin DLQ routes (mounted after actorMiddleware, inside /api)
// ---------------------------------------------------------------------------

export function cadAdminRoutes(db: Db) {
  const router = Router();

  /** GET /admin/cad/dlq?agencyCode=&status= */
  router.get("/admin/cad/dlq", async (req, res) => {
    assertBoard(req);
    const agencyCode = typeof req.query["agencyCode"] === "string" ? req.query["agencyCode"] : undefined;
    const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;

    const conditions = [];
    if (agencyCode) conditions.push(eq(cadWebhookDlq.agencyCode, agencyCode));
    if (status === "pending" || status === "exhausted" || status === "replayed") {
      conditions.push(eq(cadWebhookDlq.status, status));
    }

    const rows = await db
      .select()
      .from(cadWebhookDlq)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(200);

    res.json({ entries: rows });
  });

  /** POST /admin/cad/dlq/:id/replay — re-process a DLQ entry */
  router.post("/admin/cad/dlq/:id/replay", async (req, res) => {
    assertBoard(req);
    const { id } = req.params;

    const [entry] = await db
      .select()
      .from(cadWebhookDlq)
      .where(eq(cadWebhookDlq.id, id))
      .limit(1);

    if (!entry) {
      throw notFound("DLQ entry not found");
    }

    // Resolve agency config for replay (need companyId + secret)
    const [config] = await db
      .select()
      .from(agencyWebhookConfigs)
      .where(and(eq(agencyWebhookConfigs.agencyCode, entry.agencyCode), eq(agencyWebhookConfigs.isActive, true)))
      .limit(1);

    if (!config) {
      res.status(422).json({ error: "Agency config not found or inactive; cannot replay" });
      return;
    }

    let payload: NormalizedPayload;
    try {
      payload = normalizePayload(entry.contentType, Buffer.from(entry.rawPayload, "utf-8"));
      payload.agencyCode = config.agencyCode;
    } catch {
      res.status(422).json({ error: "Stored payload is unparseable; cannot replay" });
      return;
    }

    if (!payload.incidentId) {
      res.status(422).json({ error: "Stored payload has no incident_id; cannot replay" });
      return;
    }

    const row = await ingestPayload(db, { companyId: config.companyId, agencyCode: config.agencyCode }, payload);

    await db
      .update(cadWebhookDlq)
      .set({ status: "replayed", resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(cadWebhookDlq.id, id));

    const isNew = row.createdAt.getTime() === row.updatedAt.getTime();
    res.json({
      alertId: row.id,
      created: isNew,
      incidentId: payload.incidentId,
      replayed: true,
    });
  });

  return router;
}

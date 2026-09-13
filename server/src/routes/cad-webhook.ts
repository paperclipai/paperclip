import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agencyWebhookConfigs, solarisAlerts } from "@paperclipai/db";

const SIGNATURE_HEADER = "x-cad-signature";
const AGENCY_CODE_HEADER = "x-cad-agency-code";

function verifyHmac(secret: string, rawBody: Buffer, providedSig: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const normalised = providedSig.replace(/^sha256=/, "");
  if (normalised.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(normalised), Buffer.from(expected));
}

function parseXml(xml: string): Record<string, string> {
  // Thin XML adapter: extract leaf-element text values via regex.
  // Supports TriTech CadInterface v3 and Motorola PremierOne flat structures.
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<([A-Za-z][A-Za-z0-9_]*)>([^<]*)<\/\1>/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

function normalizePayload(
  contentType: string,
  rawBody: Buffer,
): {
  incidentId: string | null;
  incidentName: string | null;
  incidentType: string | null;
  lat: number | null;
  lon: number | null;
  reportedAt: Date | null;
  agencyCode: string | null;
} {
  const isXml = contentType.includes("xml");

  if (isXml) {
    const fields = parseXml(rawBody.toString("utf-8"));
    const lat = parseFloat(fields["Latitude"] ?? fields["lat"] ?? "");
    const lon = parseFloat(fields["Longitude"] ?? fields["lon"] ?? "");
    const ts = fields["CallDateTime"] ?? fields["reported_at"] ?? fields["Timestamp"] ?? null;
    return {
      incidentId: fields["IncidentId"] ?? fields["incident_id"] ?? null,
      incidentName: fields["IncidentName"] ?? fields["incident_name"] ?? fields["CallType"] ?? null,
      incidentType: fields["IncidentType"] ?? fields["incident_type"] ?? null,
      lat: isNaN(lat) ? null : lat,
      lon: isNaN(lon) ? null : lon,
      reportedAt: ts ? new Date(ts) : null,
      agencyCode: fields["AgencyCode"] ?? fields["agency_code"] ?? null,
    };
  }

  // JSON
  const body = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
  const lat = typeof body["lat"] === "number" ? body["lat"] : parseFloat(String(body["lat"] ?? ""));
  const lon = typeof body["lon"] === "number" ? body["lon"] : parseFloat(String(body["lon"] ?? ""));
  const ts = typeof body["reported_at"] === "string" ? body["reported_at"] : null;
  return {
    incidentId: typeof body["incident_id"] === "string" ? body["incident_id"] : null,
    incidentName: typeof body["incident_name"] === "string" ? body["incident_name"] : null,
    incidentType: typeof body["incident_type"] === "string" ? body["incident_type"] : null,
    lat: isNaN(lat) ? null : lat,
    lon: isNaN(lon) ? null : lon,
    reportedAt: ts ? new Date(ts) : null,
    agencyCode: typeof body["agency_code"] === "string" ? body["agency_code"] : null,
  };
}

export function cadWebhookRoutes(db: Db) {
  const router = Router();

  // POST /api/cad/webhook
  // Mounted BEFORE actorMiddleware — CAD systems do not have user sessions.
  // Authentication: HMAC-SHA256 over raw body using per-agency secret from agency_webhook_configs.
  router.post(
    "/api/cad/webhook",
    // Capture raw body for HMAC verification for non-JSON content types
    (req, _res, next) => {
      const ct = req.headers["content-type"] ?? "";
      if (!ct.includes("json")) {
        // express.json() already stores rawBody for JSON; capture for XML here
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

      let payload: ReturnType<typeof normalizePayload>;
      try {
        payload = normalizePayload(contentType, rawBody);
      } catch {
        res.status(400).json({ error: "Unparseable payload" });
        return;
      }

      // Agency code from header takes precedence; fall back to payload field
      const agencyCode = agencyCodeHeader || payload.agencyCode || null;
      if (!agencyCode) {
        res.status(400).json({ error: "Missing agency code" });
        return;
      }

      if (!payload.incidentId) {
        res.status(400).json({ error: "incident_id is required" });
        return;
      }

      // Resolve agency config — must be active; we don't know companyId from the
      // request so we look up by agency_code across all active configs.
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

      // Build alert title from normalized fields
      const title = payload.incidentName ?? payload.incidentType ?? `CAD Dispatch — ${agencyCode}`;
      const geoText =
        payload.lat != null && payload.lon != null
          ? `${payload.lat.toFixed(6)},${payload.lon.toFixed(6)}`
          : null;

      // Idempotent upsert: ON CONFLICT (incident_id) updates mutable fields
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
          createdBy: agencyCode,
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

      const isNew = row.createdAt.getTime() === row.updatedAt.getTime();

      res.status(isNew ? 201 : 200).json({
        alertId: row.id,
        created: isNew,
        incidentId: payload.incidentId,
      });
    },
  );

  return router;
}

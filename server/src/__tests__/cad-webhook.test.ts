import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { cadWebhookRoutes } from "../routes/cad-webhook.js";
import { errorHandler } from "../middleware/error-handler.js";

const SIGNATURE_HEADER = "x-cad-signature";
const AGENCY_CODE_HEADER = "x-cad-agency-code";

const AGENCY_SECRET = "sffd-dev-secret-32bytes-padxxxxx";
const AGENCY_CODE = "SFFD";
const COMPANY_ID = "company-uuid-1";

function sign(body: string | Buffer): string {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  return "sha256=" + createHmac("sha256", AGENCY_SECRET).update(buf).digest("hex");
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    companyId: COMPANY_ID,
    agencyName: "San Francisco Fire Department",
    agencyCode: AGENCY_CODE,
    webhookSecret: AGENCY_SECRET,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAlert(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "alert-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createApp(db: Db) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(cadWebhookRoutes(db));
  app.use(errorHandler);
  return app;
}

function makeDb(configRows: unknown[], alertReturn: unknown[]): Db {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      const idx = selectCallCount - 1;
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(idx === 0 ? configRows : []),
      };
    }),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(alertReturn),
  } as unknown as Db;
}

// ---------------------------------------------------------------------------
// POST /api/cad/webhook — JSON
// ---------------------------------------------------------------------------

describe("POST /api/cad/webhook — JSON", () => {
  const payload = JSON.stringify({
    incident_id: "INC-2026-001",
    incident_name: "Structure Fire — Main St",
    incident_type: "FIRE",
    lat: 37.7749,
    lon: -122.4194,
    reported_at: "2026-09-13T20:00:00Z",
    agency_code: AGENCY_CODE,
  });

  it("creates a new alert and returns 201 (JSON)", async () => {
    const now = new Date();
    const alert = makeAlert({ id: "alert-new", createdAt: now, updatedAt: now });
    const db = makeDb([makeConfig()], [alert]);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.alertId).toBe("alert-new");
    expect(res.body.created).toBe(true);
    expect(res.body.incidentId).toBe("INC-2026-001");
  });

  it("returns 200 with created=false for an existing incident (updatedAt != createdAt)", async () => {
    const createdAt = new Date("2026-09-13T20:00:00Z");
    const updatedAt = new Date("2026-09-13T21:00:00Z");
    const alert = makeAlert({ id: "alert-dup", createdAt, updatedAt });
    const db = makeDb([makeConfig()], [alert]);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });

  it("returns 401 for wrong HMAC", async () => {
    const db = makeDb([makeConfig()], []);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, "sha256=badhash")
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(401);
  });

  it("returns 401 when agency code is unknown", async () => {
    const db = makeDb([], []);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, "UNKNOWN")
      .send(payload);

    expect(res.status).toBe(401);
  });

  it("returns 400 when incident_id is missing", async () => {
    const badPayload = JSON.stringify({ incident_name: "Test" });
    const db = makeDb([makeConfig()], []);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(badPayload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(badPayload);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("incident_id");
  });

  it("returns 400 when body is empty", async () => {
    const db = makeDb([makeConfig()], []);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(""))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE);

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/cad/webhook — XML (TriTech CadInterface v3 style)
// ---------------------------------------------------------------------------

const XML_PAYLOAD = `<?xml version="1.0" encoding="UTF-8"?>
<CadEvent>
  <IncidentId>INC-XML-001</IncidentId>
  <IncidentName>Brush Fire — Hill Rd</IncidentName>
  <IncidentType>BRUSH</IncidentType>
  <Latitude>34.0522</Latitude>
  <Longitude>-118.2437</Longitude>
  <CallDateTime>2026-09-13T19:00:00Z</CallDateTime>
  <AgencyCode>SFFD</AgencyCode>
</CadEvent>`;

describe("POST /api/cad/webhook — XML", () => {
  it("parses XML and creates alert (201)", async () => {
    const now = new Date();
    const alert = makeAlert({ id: "alert-xml", createdAt: now, updatedAt: now });
    const db = makeDb([makeConfig()], [alert]);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/xml")
      .set(SIGNATURE_HEADER, sign(XML_PAYLOAD))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(XML_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.incidentId).toBe("INC-XML-001");
  });

  it("returns 401 for bad HMAC on XML", async () => {
    const db = makeDb([makeConfig()], []);

    const res = await request(createApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/xml")
      .set(SIGNATURE_HEADER, "sha256=deadbeef")
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(XML_PAYLOAD);

    expect(res.status).toBe(401);
  });
});


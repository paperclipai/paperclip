import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { cadWebhookRoutes, cadAdminRoutes } from "../routes/cad-webhook.js";
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
  return { id: "alert-1", createdAt: now, updatedAt: now, ...overrides };
}

// ---------------------------------------------------------------------------
// DB mock factories
// ---------------------------------------------------------------------------

function makeWebhookDb(configRows: unknown[], alertReturn: unknown[]): Db {
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
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  } as unknown as Db;
}

// DLQ-aware db mock: first select returns config, subsequent selects return DLQ rows
function makeDlqDb(dlqRows: unknown[]): Db {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      const idx = selectCallCount - 1;
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(idx === 0 ? [makeConfig()] : dlqRows),
      };
    }),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue([]),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockRejectedValue(new Error("DB connection lost")), // simulate transient failure
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  } as unknown as Db;
}

function createWebhookApp(db: Db) {
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

function createAdminApp(db: Db) {
  const app = express();
  app.use(express.json());
  // Simulate board actor middleware
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "board", userId: "user-1", companyIds: [COMPANY_ID] };
    next();
  });
  app.use(cadAdminRoutes(db));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// POST /api/cad/webhook — generic JSON (existing behaviour)
// ---------------------------------------------------------------------------

describe("POST /api/cad/webhook — generic JSON", () => {
  const payload = JSON.stringify({
    incident_id: "INC-2026-001",
    incident_name: "Structure Fire — Main St",
    incident_type: "FIRE",
    lat: 37.7749,
    lon: -122.4194,
    reported_at: "2026-09-13T20:00:00Z",
    agency_code: AGENCY_CODE,
  });

  it("creates a new alert and returns 201", async () => {
    const now = new Date();
    const alert = makeAlert({ id: "alert-new", createdAt: now, updatedAt: now });
    const db = makeWebhookDb([makeConfig()], [alert]);

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.alertId).toBe("alert-new");
    expect(res.body.created).toBe(true);
    expect(res.body.incidentId).toBe("INC-2026-001");
    expect(res.body.vendor).toBe("generic");
  });

  it("returns 200 with created=false for an existing incident", async () => {
    const createdAt = new Date("2026-09-13T20:00:00Z");
    const updatedAt = new Date("2026-09-13T21:00:00Z");
    const alert = makeAlert({ id: "alert-dup", createdAt, updatedAt });
    const db = makeWebhookDb([makeConfig()], [alert]);

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
  });

  it("returns 401 for wrong HMAC", async () => {
    const db = makeWebhookDb([makeConfig()], []);
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, "sha256=badhash")
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);
    expect(res.status).toBe(401);
  });

  it("returns 401 when agency code is unknown", async () => {
    const db = makeWebhookDb([], []);
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, "UNKNOWN")
      .send(payload);
    expect(res.status).toBe(401);
  });

  it("returns 400 when incident_id is missing", async () => {
    const badPayload = JSON.stringify({ incident_name: "Test" });
    const db = makeWebhookDb([makeConfig()], []);
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(badPayload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(badPayload);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("incident_id");
  });

  it("returns 400 when body is empty", async () => {
    const db = makeWebhookDb([makeConfig()], []);
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(""))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// TriTech JSON adapter
// ---------------------------------------------------------------------------

describe("POST /api/cad/webhook — TriTech JSON adapter", () => {
  const tritechPayload = JSON.stringify({
    CallNumber: "INC-TRITECH-001",
    NatureOfCall: "Brush Fire — Hill Rd",
    CallType: "BRUSH",
    Latitude: 34.0522,
    Longitude: -118.2437,
    CallEnteredDateTime: "2026-09-14T10:00:00Z",
    Agency: AGENCY_CODE,
  });

  it("maps TriTech fields and returns 201 with vendor=tritech", async () => {
    const now = new Date();
    const alert = makeAlert({ id: "alert-tt", createdAt: now, updatedAt: now });
    const db = makeWebhookDb([makeConfig()], [alert]);

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(tritechPayload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(tritechPayload);

    expect(res.status).toBe(201);
    expect(res.body.incidentId).toBe("INC-TRITECH-001");
    expect(res.body.vendor).toBe("tritech");
  });

  it("detects TriTech from NatureOfCall+CallType without incident_id", async () => {
    const payload = JSON.stringify({
      CallNumber: "INC-TRITECH-002",
      NatureOfCall: "Vehicle Accident",
      CallType: "MVA",
      Latitude: 37.0,
      Longitude: -122.0,
      CallDateTime: "2026-09-14T11:00:00Z",
      AgencyCode: AGENCY_CODE,
    });
    const now = new Date();
    const db = makeWebhookDb([makeConfig()], [makeAlert({ id: "alert-tt2", createdAt: now, updatedAt: now })]);

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.vendor).toBe("tritech");
  });
});

// ---------------------------------------------------------------------------
// Motorola PremierOne XML adapter
// ---------------------------------------------------------------------------

const MOTOROLA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PremierOneEvent xmlns:pm="urn:motorola:premierone:cad:v1">
  <pm:IncidentNumber>MOT-2026-001</pm:IncidentNumber>
  <pm:NatureOfCall>Structure Fire</pm:NatureOfCall>
  <pm:IncidentCategory>FIRE</pm:IncidentCategory>
  <pm:Latitude>37.7749</pm:Latitude>
  <pm:Longitude>-122.4194</pm:Longitude>
  <pm:CallReceivedDateTime>2026-09-14T08:00:00Z</pm:CallReceivedDateTime>
  <pm:AgencyCode>SFFD</pm:AgencyCode>
</PremierOneEvent>`;

describe("POST /api/cad/webhook — Motorola PremierOne XML adapter", () => {
  it("maps PremierOne XML fields with namespace stripping and returns 201 vendor=motorola", async () => {
    const now = new Date();
    const alert = makeAlert({ id: "alert-mot", createdAt: now, updatedAt: now });
    const db = makeWebhookDb([makeConfig()], [alert]);

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/xml")
      .set(SIGNATURE_HEADER, sign(MOTOROLA_XML))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(MOTOROLA_XML);

    expect(res.status).toBe(201);
    expect(res.body.incidentId).toBe("MOT-2026-001");
    expect(res.body.vendor).toBe("motorola");
  });

  it("returns 401 for bad HMAC on Motorola XML", async () => {
    const db = makeWebhookDb([makeConfig()], []);
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/xml")
      .set(SIGNATURE_HEADER, "sha256=deadbeef")
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(MOTOROLA_XML);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Generic XML adapter (TriTech CadInterface v3 style)
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

describe("POST /api/cad/webhook — generic XML", () => {
  it("parses generic XML and creates alert (201)", async () => {
    const now = new Date();
    const alert = makeAlert({ id: "alert-xml", createdAt: now, updatedAt: now });
    const db = makeWebhookDb([makeConfig()], [alert]);

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/xml")
      .set(SIGNATURE_HEADER, sign(XML_PAYLOAD))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(XML_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.incidentId).toBe("INC-XML-001");
  });

  it("returns 401 for bad HMAC on XML", async () => {
    const db = makeWebhookDb([makeConfig()], []);
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/xml")
      .set(SIGNATURE_HEADER, "sha256=deadbeef")
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(XML_PAYLOAD);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DLQ — transient failure tracking
// ---------------------------------------------------------------------------

describe("POST /api/cad/webhook — DLQ on transient failure", () => {
  const payload = JSON.stringify({
    incident_id: "INC-DLQ-001",
    incident_name: "Test Incident",
    incident_type: "TEST",
    lat: 37.0,
    lon: -122.0,
    reported_at: "2026-09-14T12:00:00Z",
    agency_code: AGENCY_CODE,
  });

  it("returns 500 and writes DLQ entry on first transient failure", async () => {
    // DB: config resolves OK, but insert.returning throws
    // DLQ select (second select call) returns empty (no prior DLQ entry)
    const db = makeDlqDb([]); // no existing DLQ entry

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(500);
    // DLQ insert should have been called
    expect((db as unknown as { insert: ReturnType<typeof vi.fn> }).insert).toHaveBeenCalled();
  });

  it("returns 202 with exhausted=true after max retries exceeded", async () => {
    const db = makeDlqDb([
      // existing DLQ entry with attemptCount = MAX_DLQ_RETRIES (3)
      {
        id: "dlq-1",
        attemptCount: 3,
        status: "pending",
        nextRetryAt: new Date(Date.now() - 1000),
      },
    ]);

    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(payload))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body.exhausted).toBe(true);
    expect(res.body.incidentId).toBe("INC-DLQ-001");
  });
});

// ---------------------------------------------------------------------------
// Admin DLQ routes
// ---------------------------------------------------------------------------

describe("GET /admin/cad/dlq", () => {
  it("returns DLQ entries for admin", async () => {
    const dlqRows = [
      {
        id: "dlq-1",
        agencyCode: AGENCY_CODE,
        incidentId: "INC-001",
        rawPayload: "{}",
        contentType: "application/json",
        vendor: "generic",
        errorReason: "DB error",
        attemptCount: 1,
        status: "pending",
        nextRetryAt: new Date(),
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(dlqRows),
    } as unknown as Db;

    const res = await request(createAdminApp(db)).get("/admin/cad/dlq");
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].agencyCode).toBe(AGENCY_CODE);
  });
});

describe("POST /admin/cad/dlq/:id/replay", () => {
  const replayPayload = JSON.stringify({
    incident_id: "INC-REPLAY-001",
    incident_name: "Replayed Incident",
    incident_type: "FIRE",
    lat: 37.0,
    lon: -122.0,
    reported_at: "2026-09-14T12:00:00Z",
    agency_code: AGENCY_CODE,
  });

  it("replays a DLQ entry and returns alertId", async () => {
    const dlqEntry = {
      id: "dlq-replay-1",
      companyId: COMPANY_ID,
      agencyCode: AGENCY_CODE,
      incidentId: "INC-REPLAY-001",
      rawPayload: replayPayload,
      contentType: "application/json",
      vendor: "generic",
      errorReason: "DB error",
      attemptCount: 2,
      status: "pending",
      nextRetryAt: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const now = new Date();
    const alert = makeAlert({ id: "alert-replayed", createdAt: now, updatedAt: now });

    let selectCall = 0;
    const db = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          selectCall++;
          if (selectCall === 1) return Promise.resolve([dlqEntry]);     // DLQ entry
          if (selectCall === 2) return Promise.resolve([makeConfig()]); // agency config
          return Promise.resolve([]);
        }),
      })),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([alert]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createAdminApp(db))
      .post("/admin/cad/dlq/dlq-replay-1/replay");

    expect(res.status).toBe(200);
    expect(res.body.alertId).toBe("alert-replayed");
    expect(res.body.replayed).toBe(true);
    expect(res.body.incidentId).toBe("INC-REPLAY-001");
  });

  it("returns 404 when DLQ entry does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createAdminApp(db))
      .post("/admin/cad/dlq/nonexistent/replay");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Trial cap enforcement
// ---------------------------------------------------------------------------

describe("POST /api/cad/webhook — trial cap enforcement", () => {
  const body = JSON.stringify({
    CallNumber: "INC-CAP-001",
    NatureOfCall: "Medical",
    CallType: "EMS",
    Latitude: 37.78,
    Longitude: -122.41,
    CallEnteredDateTime: "2026-09-14T12:00:00Z",
    Agency: AGENCY_CODE,
  });

  function makeTrialDb(trial: { id: string; incidentCount: number; incidentCap: number } | null): Db {
    let selectCallCount = 0;
    const alert = makeAlert({ id: "alert-cap-1" });
    return {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockImplementation(() => {
            if (selectCallCount === 1) return Promise.resolve([makeConfig()]);
            if (selectCallCount === 2) return Promise.resolve(trial ? [{ ...trial, trialStatus: "active" }] : []);
            return Promise.resolve([]);
          }),
        };
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([alert]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;
  }

  it("allows ingestion when trial has remaining capacity", async () => {
    const db = makeTrialDb({ id: "trial-1", incidentCount: 500, incidentCap: 1000 });
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(body))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.trial.incidentCount).toBe(501);
    expect(res.body.trial.incidentCap).toBe(1000);
  });

  it("returns 429 when trial incident cap is reached", async () => {
    const db = makeTrialDb({ id: "trial-1", incidentCount: 1000, incidentCap: 1000 });
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(body))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(body);
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/cap/i);
    expect(res.body.cap).toBe(1000);
  });

  it("allows ingestion when there is no active trial (non-trial agency)", async () => {
    const db = makeTrialDb(null);
    const res = await request(createWebhookApp(db))
      .post("/api/cad/webhook")
      .set("Content-Type", "application/json")
      .set(SIGNATURE_HEADER, sign(body))
      .set(AGENCY_CODE_HEADER, AGENCY_CODE)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.trial).toBeUndefined();
  });
});

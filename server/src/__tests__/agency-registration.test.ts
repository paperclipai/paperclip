import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { agencyRegistrationRoutes, agencyTrialRoutes } from "../routes/agency-registration.js";
import type { AgencyEmailClient } from "../services/agency-email.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmailClient(): AgencyEmailClient {
  return {
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendDay7: vi.fn().mockResolvedValue(undefined),
    sendDay25: vi.fn().mockResolvedValue(undefined),
    sendUpgradeConfirmation: vi.fn().mockResolvedValue(undefined),
  };
}

/** DB mock for registration: no existing code, prefix OK, then inserts. */
function makeRegistrationDb(): Db {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]), // no conflicts
      };
    }),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation((_cols: unknown) => {
        // Alternate returns: company, config, trial
        const call = (selectCallCount % 3) || 3;
        if (call === 1) return Promise.resolve([{ id: "company-1" }]);
        if (call === 2) return Promise.resolve([{ id: "config-1" }]);
        return Promise.resolve([{ id: "trial-1", trialEndsAt: new Date(Date.now() + 30 * 86400000) }]);
      }),
    })),
  } as unknown as Db;
}

/** Simpler multi-call db mock that tracks insert sequence. */
function makeSequentialDb(): Db {
  let insertSeq = 0;
  const company = { id: "company-1" };
  const config = { id: "config-1" };
  const trial = { id: "trial-1", trialEndsAt: new Date(Date.now() + 30 * 86400000) };

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    }),
    insert: vi.fn().mockImplementation(() => {
      insertSeq++;
      const seq = insertSeq;
      return {
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockImplementation(() => {
          if (seq === 1) return Promise.resolve([company]);
          if (seq === 2) return Promise.resolve([config]);
          return Promise.resolve([trial]);
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        catch: vi.fn().mockReturnThis(),
      };
    }),
  } as unknown as Db;
}

function createPublicApp(db: Db, emailClient: AgencyEmailClient) {
  const app = express();
  app.use(express.json());
  app.use(agencyRegistrationRoutes(db, emailClient));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("POST /api/agency/register", () => {
  it("returns 400 when agencyName is missing", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app)
      .post("/api/agency/register")
      .send({ agencyCode: "SFFD", contactEmail: "test@example.com" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when agencyCode is invalid", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).post("/api/agency/register").send({
      agencyName: "Test Agency",
      agencyCode: "invalid code!", // spaces and ! are invalid
      contactEmail: "test@example.com",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agencyCode/);
  });

  it("returns 400 when contactEmail is missing", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).post("/api/agency/register").send({
      agencyName: "Test Agency",
      agencyCode: "SFFD",
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when agency code already exists", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: "existing-config" }]), // conflict
      }),
    } as unknown as Db;
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).post("/api/agency/register").send({
      agencyName: "Test Agency",
      agencyCode: "SFFD",
      contactEmail: "test@example.com",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already registered/);
  });

  it("returns 201 with webhook credentials on success", async () => {
    const db = makeSequentialDb();
    const emailClient = makeEmailClient();
    const app = createPublicApp(db, emailClient);
    const res = await request(app).post("/api/agency/register").send({
      agencyName: "San Francisco Fire Department",
      agencyCode: "SFFD",
      contactEmail: "ops@sffd.gov",
      contactName: "Fire Captain",
      vendor: "tritech",
    });
    expect(res.status).toBe(201);
    expect(res.body.trialId).toBe("trial-1");
    expect(res.body.webhookUrl).toContain("/api/cad/webhook");
    expect(res.body.webhookSecret).toHaveLength(64); // 32 bytes hex
    expect(res.body.agencyCode).toBe("SFFD");
    expect(res.body.incidentCap).toBe(1000);
    expect(res.body.setupWizard.vendor).toBe("tritech");
    expect(res.body.setupWizard.steps).toHaveLength(4);
  });

  it("includes motorola wizard when vendor=motorola", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).post("/api/agency/register").send({
      agencyName: "LAPD",
      agencyCode: "LAPD",
      contactEmail: "it@lapd.gov",
      vendor: "motorola",
    });
    expect(res.status).toBe(201);
    expect(res.body.setupWizard.vendor).toBe("motorola");
    expect(res.body.setupWizard.steps).toHaveLength(5);
  });

  it("falls back to generic wizard for unknown vendor", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).post("/api/agency/register").send({
      agencyName: "Generic Fire",
      agencyCode: "GF",
      contactEmail: "fire@generic.gov",
      vendor: "other_cad",
    });
    expect(res.status).toBe(201);
    expect(res.body.setupWizard.vendor).toBe("generic");
  });

  it("queues welcome email on successful registration", async () => {
    const db = makeSequentialDb();
    const emailClient = makeEmailClient();
    const app = createPublicApp(db, emailClient);
    await request(app).post("/api/agency/register").send({
      agencyName: "Test Fire",
      agencyCode: "TF",
      contactEmail: "fire@test.gov",
    });
    // Email is fire-and-forget; give it one microtask cycle
    await new Promise((r) => setTimeout(r, 10));
    expect(emailClient.sendWelcome).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Setup wizard tests
// ---------------------------------------------------------------------------

describe("GET /api/agency/setup-wizard", () => {
  it("returns tritech steps", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).get(
      "/api/agency/setup-wizard?vendor=tritech&agencyCode=SFFD",
    );
    expect(res.status).toBe(200);
    expect(res.body.vendor).toBe("tritech");
    expect(res.body.steps.length).toBeGreaterThan(0);
  });

  it("returns motorola steps", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).get("/api/agency/setup-wizard?vendor=motorola");
    expect(res.status).toBe(200);
    expect(res.body.vendor).toBe("motorola");
  });

  it("defaults to generic when vendor omitted", async () => {
    const db = makeSequentialDb();
    const app = createPublicApp(db, makeEmailClient());
    const res = await request(app).get("/api/agency/setup-wizard");
    expect(res.status).toBe(200);
    expect(res.body.vendor).toBe("generic");
  });
});

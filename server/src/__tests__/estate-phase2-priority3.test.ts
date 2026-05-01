import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { DEFAULT_REVIEW_CHECKLIST } from "@paperclipai/db";
import { estateRoutes } from "../routes/estate.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boardActor(companyId = "company-1") {
  return {
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "user-1",
    companyIds: [companyId],
  };
}

function createApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = boardActor();
    next();
  });
  app.use(estateRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-06-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");

function makeReminder(overrides: Record<string, unknown> = {}) {
  return {
    id: "reminder-1",
    assetId: "asset-1",
    companyId: "company-1",
    userId: "user-1",
    frequency: "annual",
    frequencyDays: 365,
    lastRemindedAt: null,
    nextDueAt: FUTURE,
    isActive: true,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-1",
    companyId: "company-1",
    userId: "user-1",
    assetId: "asset-1",
    documentName: "Home Insurance Policy",
    alertType: "insurance_renewal",
    expiresAt: FUTURE,
    alertDaysBefore: [30, 60, 90],
    lastAlertedAt: null,
    status: "active",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "review-1",
    companyId: "company-1",
    userId: "user-1",
    reviewYear: 2026,
    status: "pending",
    checklist: DEFAULT_REVIEW_CHECKLIST,
    notes: null,
    reviewedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeTaxBill(overrides: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    assetId: "asset-1",
    companyId: "company-1",
    userId: "user-1",
    state: "CA",
    county: "Los Angeles",
    taxYear: 2026,
    installment: 1,
    dueDate: FUTURE,
    amountCents: "500000",
    status: "upcoming",
    paidAt: null,
    paidAmountCents: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valuation Reminders
// ---------------------------------------------------------------------------

describe("GET /estate/valuation-reminders", () => {
  it("returns reminder list for a user", async () => {
    const reminder = makeReminder();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([reminder]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/valuation-reminders?companyId=company-1&userId=user-1");
    expect(res.status).toBe(200);
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.reminders[0].id).toBe("reminder-1");
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/valuation-reminders");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/companyId/);
  });
});

describe("POST /estate/valuation-reminders", () => {
  it("creates a valuation reminder (201)", async () => {
    const reminder = makeReminder();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([reminder]) }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/valuation-reminders")
      .send({ companyId: "company-1", userId: "user-1", assetId: "asset-1", nextDueAt: FUTURE.toISOString() });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("reminder-1");
  });

  it("returns 400 when assetId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/valuation-reminders")
      .send({ companyId: "company-1", nextDueAt: FUTURE.toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assetId/);
  });

  it("returns 400 when nextDueAt is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/valuation-reminders")
      .send({ companyId: "company-1", assetId: "asset-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nextDueAt/);
  });

  it("defaults frequencyDays from frequency name", async () => {
    let capturedValues: Record<string, unknown> | null = null;
    const reminder = makeReminder({ frequency: "quarterly", frequencyDays: 91 });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([reminder]) };
        }),
      }),
    } as unknown as Db;

    await request(createApp(db))
      .post("/estate/valuation-reminders")
      .send({ companyId: "company-1", assetId: "asset-1", nextDueAt: FUTURE.toISOString(), frequency: "quarterly" });

    expect(capturedValues).not.toBeNull();
    expect((capturedValues as Record<string, unknown>).frequencyDays).toBe(91);
  });
});

describe("PATCH /estate/valuation-reminders/:id", () => {
  it("updates a reminder", async () => {
    const updated = makeReminder({ isActive: false });
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/valuation-reminders/reminder-1")
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  it("returns 404 when reminder not found", async () => {
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/valuation-reminders/nonexistent")
      .send({ isActive: false });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /estate/valuation-reminders/:id", () => {
  it("deletes a reminder", async () => {
    const reminder = makeReminder();
    const db = {
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([reminder]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/valuation-reminders/reminder-1");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 when not found", async () => {
    const db = {
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/valuation-reminders/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Document Expiry Alerts
// ---------------------------------------------------------------------------

describe("GET /estate/document-alerts", () => {
  it("returns alert list with daysUntilExpiry annotation", async () => {
    const alert = makeAlert({ expiresAt: new Date(Date.now() + 10 * 86_400_000) });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([alert]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/document-alerts?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].daysUntilExpiry).toBeDefined();
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/document-alerts");
    expect(res.status).toBe(400);
  });
});

describe("POST /estate/document-alerts", () => {
  it("creates a document alert (201)", async () => {
    const alert = makeAlert();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([alert]) }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/document-alerts")
      .send({
        companyId: "company-1",
        documentName: "Home Insurance Policy",
        alertType: "insurance_renewal",
        expiresAt: FUTURE.toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.documentName).toBe("Home Insurance Policy");
  });

  it("returns 400 when documentName is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/document-alerts")
      .send({ companyId: "company-1", expiresAt: FUTURE.toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documentName/);
  });

  it("returns 400 when expiresAt is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/document-alerts")
      .send({ companyId: "company-1", documentName: "Policy" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expiresAt/);
  });
});

describe("PATCH /estate/document-alerts/:id", () => {
  it("dismisses an alert", async () => {
    const updated = makeAlert({ status: "dismissed" });
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updated]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/document-alerts/alert-1")
      .send({ status: "dismissed" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("dismissed");
  });
});

describe("DELETE /estate/document-alerts/:id", () => {
  it("deletes an alert", async () => {
    const alert = makeAlert();
    const db = {
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([alert]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/document-alerts/alert-1");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Annual Estate Review Workflow
// ---------------------------------------------------------------------------

describe("GET /estate/reviews/:year", () => {
  it("returns existing review", async () => {
    const review = makeReview();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([review]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/reviews/2026?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.reviewYear).toBe(2026);
    expect(Array.isArray(res.body.checklist)).toBe(true);
    expect(res.body.checklist.length).toBeGreaterThan(0);
  });

  it("auto-creates review with default checklist when none exists", async () => {
    const review = makeReview();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([review]) }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/reviews/2026?companyId=company-1");
    expect(res.status).toBe(201);
    expect(res.body.checklist).toHaveLength(DEFAULT_REVIEW_CHECKLIST.length);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/reviews/2026");
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric year", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/reviews/banana?companyId=company-1");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /estate/reviews/:year", () => {
  it("marks a checklist item complete and auto-advances status to in_progress", async () => {
    const checklist = DEFAULT_REVIEW_CHECKLIST.map((item) => ({ ...item }));
    const existingReview = makeReview({ checklist, status: "pending" });

    const updatedChecklist = checklist.map((item) =>
      item.id === "update_valuations" ? { ...item, completed: true } : item,
    );
    const updatedReview = makeReview({ checklist: updatedChecklist, status: "in_progress" });

    // select chain: select().from().where() → Promise
    // update chain: update().set().where().returning() → Promise
    const selectWhereMock = vi.fn().mockResolvedValue([existingReview]);
    const updateReturningMock = vi.fn().mockResolvedValue([updatedReview]);
    const updateWhereMock = vi.fn().mockReturnValue({ returning: updateReturningMock });

    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: selectWhereMock }) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhereMock }) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/reviews/2026?companyId=company-1")
      .send({ checklistItemId: "update_valuations", checklistCompleted: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("sets status to complete when all items are done", async () => {
    const allDoneChecklist = DEFAULT_REVIEW_CHECKLIST.map((item) => ({ ...item, completed: true }));
    const existingReview = makeReview({ checklist: allDoneChecklist, status: "in_progress" });
    const completedReview = makeReview({ checklist: allDoneChecklist, status: "complete", reviewedAt: NOW });

    const selectWhereMock = vi.fn().mockResolvedValue([existingReview]);
    const updateReturningMock = vi.fn().mockResolvedValue([completedReview]);
    const updateWhereMock = vi.fn().mockReturnValue({ returning: updateReturningMock });

    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: selectWhereMock }) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhereMock }) }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/reviews/2026?companyId=company-1")
      .send({ checklist: allDoneChecklist });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("complete");
  });

  it("returns 404 when review not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/reviews/2026?companyId=company-1")
      .send({ notes: "updated" });

    expect(res.status).toBe(404);
  });
});

describe("GET /estate/reviews", () => {
  it("returns review list for a user", async () => {
    const review = makeReview();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([review]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/reviews?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].reviewYear).toBe(2026);
  });
});

// ---------------------------------------------------------------------------
// Multi-State Property Tax Calendar
// ---------------------------------------------------------------------------

describe("GET /estate/property-tax", () => {
  it("returns tax bill list with overdue and daysUntilDue annotations", async () => {
    const pastDue = makeTaxBill({ dueDate: new Date(Date.now() - 86_400_000), status: "upcoming" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([pastDue]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/estate/property-tax?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0].isOverdue).toBe(true);
    expect(res.body.bills[0].daysUntilDue).toBeLessThan(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/estate/property-tax");
    expect(res.status).toBe(400);
  });
});

describe("POST /estate/property-tax", () => {
  it("creates a property tax bill (201)", async () => {
    const bill = makeTaxBill();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([bill]) }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/estate/property-tax")
      .send({
        companyId: "company-1",
        assetId: "asset-1",
        state: "CA",
        taxYear: 2026,
        dueDate: FUTURE.toISOString(),
        amountCents: 500000,
      });

    expect(res.status).toBe(201);
    expect(res.body.state).toBe("CA");
  });

  it("returns 400 when assetId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/property-tax")
      .send({ companyId: "company-1", state: "CA", taxYear: 2026, dueDate: FUTURE.toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assetId/);
  });

  it("returns 400 when state is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/estate/property-tax")
      .send({ companyId: "company-1", assetId: "asset-1", taxYear: 2026, dueDate: FUTURE.toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state/);
  });
});

describe("PATCH /estate/property-tax/:id", () => {
  it("marks a bill as paid and sets paidAt", async () => {
    const paid = makeTaxBill({ status: "paid", paidAt: NOW, paidAmountCents: "500000" });
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([paid]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/property-tax/bill-1")
      .send({ status: "paid", paidAmountCents: 500000 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
  });

  it("returns 404 when bill not found", async () => {
    const db = {
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/estate/property-tax/nonexistent")
      .send({ status: "paid" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /estate/property-tax/:id", () => {
  it("deletes a tax bill", async () => {
    const bill = makeTaxBill();
    const db = {
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([bill]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/property-tax/bill-1");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it("returns 404 when not found", async () => {
    const db = {
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/estate/property-tax/nonexistent");
    expect(res.status).toBe(404);
  });
});

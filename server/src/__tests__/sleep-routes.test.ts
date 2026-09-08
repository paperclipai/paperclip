import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { sleepRoutes } from "../routes/sleep.js";
import { errorHandler } from "../middleware/error-handler.js";

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
  app.use(sleepRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-01T00:00:00.000Z");

function makeSleepRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "sleep-1",
    companyId: "company-1",
    userId: "user-1",
    sleepDate: "2026-09-08",
    durationMinutes: 420,
    quality: "good",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /sleep
// ---------------------------------------------------------------------------

describe("GET /sleep", () => {
  it("returns sleep records for the user (200)", async () => {
    const record = makeSleepRecord();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([record]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/sleep?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0].durationMinutes).toBe(420);
    expect(res.body.from).toBe("2026-09-01");
    expect(res.body.to).toBe("2026-09-08");
  });

  it("returns empty records array when none exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/sleep?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/sleep?from=2026-09-01&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/sleep?companyId=company-1&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/sleep?companyId=company-1&from=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/sleep?companyId=company-1&from=2026-09-08&to=2026-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 90 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/sleep?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/sleep?companyId=company-1&from=not-a-date&to=2026-09-08",
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when actor is not board", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent" as const, agentId: "agent-1", companyId: "company-1" };
      next();
    });
    app.use(sleepRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/sleep?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /sleep
// ---------------------------------------------------------------------------

describe("POST /sleep", () => {
  it("creates a sleep record and returns 201", async () => {
    const record = makeSleepRecord();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([record]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/sleep")
      .send({ companyId: "company-1", sleepDate: "2026-09-08", durationMinutes: 420, quality: "good" });

    expect(res.status).toBe(201);
    expect(res.body.durationMinutes).toBe(420);
    expect(res.body.quality).toBe("good");
  });

  it("upserts when the same date is posted twice", async () => {
    const record = makeSleepRecord({ durationMinutes: 480 });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([record]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/sleep")
      .send({ companyId: "company-1", sleepDate: "2026-09-08", durationMinutes: 480 });

    expect(res.status).toBe(201);
    expect(res.body.durationMinutes).toBe(480);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/sleep")
      .send({ sleepDate: "2026-09-08", durationMinutes: 420 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when sleepDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/sleep")
      .send({ companyId: "company-1", sleepDate: "bad-date", durationMinutes: 420 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when durationMinutes is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/sleep")
      .send({ companyId: "company-1", sleepDate: "2026-09-08" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when durationMinutes is zero", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/sleep")
      .send({ companyId: "company-1", sleepDate: "2026-09-08", durationMinutes: 0 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /sleep/:id
// ---------------------------------------------------------------------------

describe("DELETE /sleep/:id", () => {
  it("deletes the sleep record and returns 204", async () => {
    const record = makeSleepRecord();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([record]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/sleep/sleep-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when sleep record does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/sleep/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when sleep record belongs to a different user", async () => {
    const record = makeSleepRecord({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([record]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/sleep/sleep-1");
    expect(res.status).toBe(404);
  });
});

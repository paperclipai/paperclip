import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { moodRoutes } from "../routes/mood.js";
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
  app.use(moodRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-01T00:00:00.000Z");

function makeMoodLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "mood-1",
    companyId: "company-1",
    userId: "user-1",
    logDate: "2026-09-08",
    moodScore: 7,
    energyLevel: 8,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /mood
// ---------------------------------------------------------------------------

describe("GET /mood", () => {
  it("returns mood logs for the user (200)", async () => {
    const log = makeMoodLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/mood?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].moodScore).toBe(7);
    expect(res.body.from).toBe("2026-09-01");
    expect(res.body.to).toBe("2026-09-08");
  });

  it("returns empty logs array when none exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/mood?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(0);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/mood?from=2026-09-01&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when from is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/mood?companyId=company-1&to=2026-09-08");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get("/mood?companyId=company-1&from=2026-09-01");
    expect(res.status).toBe(400);
  });

  it("returns 400 when to is before from", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/mood?companyId=company-1&from=2026-09-08&to=2026-09-01",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when range exceeds 90 days", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/mood?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date format", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/mood?companyId=company-1&from=not-a-date&to=2026-09-08",
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
    app.use(moodRoutes({} as unknown as Db));
    app.use(errorHandler);

    const res = await request(app).get(
      "/mood?companyId=company-1&from=2026-09-01&to=2026-09-08",
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /mood
// ---------------------------------------------------------------------------

describe("POST /mood", () => {
  it("creates a mood log and returns 201", async () => {
    const log = makeMoodLog();
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([log]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "2026-09-08", moodScore: 7, energyLevel: 8 });

    expect(res.status).toBe(201);
    expect(res.body.moodScore).toBe(7);
    expect(res.body.energyLevel).toBe(8);
  });

  it("upserts when the same date is posted twice", async () => {
    const log = makeMoodLog({ moodScore: 9 });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([log]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "2026-09-08", moodScore: 9 });

    expect(res.status).toBe(201);
    expect(res.body.moodScore).toBe(9);
  });

  it("accepts a log without energyLevel", async () => {
    const log = makeMoodLog({ energyLevel: null });
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([log]),
          }),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "2026-09-08", moodScore: 5 });

    expect(res.status).toBe(201);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/mood")
      .send({ logDate: "2026-09-08", moodScore: 7 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when logDate is invalid", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "bad-date", moodScore: 7 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when moodScore is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "2026-09-08" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when moodScore is out of range (0)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "2026-09-08", moodScore: 0 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when moodScore exceeds 10", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "2026-09-08", moodScore: 11 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when energyLevel is out of range", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/mood")
      .send({ companyId: "company-1", logDate: "2026-09-08", moodScore: 7, energyLevel: 0 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /mood/:id
// ---------------------------------------------------------------------------

describe("DELETE /mood/:id", () => {
  it("deletes the mood log and returns 204", async () => {
    const log = makeMoodLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/mood/mood-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when mood log does not exist", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/mood/unknown-id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when mood log belongs to a different user", async () => {
    const log = makeMoodLog({ userId: "other-user" });
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/mood/mood-1");
    expect(res.status).toBe(404);
  });
});

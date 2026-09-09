import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { meditationRoutes } from "../routes/meditation.js";
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
  app.use(meditationRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-09T00:00:00.000Z");

function makeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    companyId: "company-1",
    userId: "user-1",
    sessionDate: "2026-09-09",
    durationMinutes: 15,
    technique: "mindfulness",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /meditation
// ---------------------------------------------------------------------------

describe("GET /meditation", () => {
  it("returns logs for the user (200)", async () => {
    const log = makeLog();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/meditation?companyId=company-1&from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].id).toBe("log-1");
  });

  it("returns empty array when no logs (200)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/meditation?companyId=company-1&from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(0);
  });

  it("rejects missing companyId (400)", async () => {
    const res = await request(createApp({} as unknown as Db)).get(
      "/meditation?from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing from (400)", async () => {
    const res = await request(createApp({} as unknown as Db)).get(
      "/meditation?companyId=company-1&to=2026-09-09",
    );
    expect(res.status).toBe(400);
  });

  it("rejects range exceeding 90 days (400)", async () => {
    const res = await request(createApp({} as unknown as Db)).get(
      "/meditation?companyId=company-1&from=2026-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /meditation
// ---------------------------------------------------------------------------

describe("POST /meditation", () => {
  it("creates a meditation log (201)", async () => {
    const log = makeLog();
    const db = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/meditation")
      .send({
        companyId: "company-1",
        sessionDate: "2026-09-09",
        durationMinutes: 15,
        technique: "mindfulness",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("log-1");
  });

  it("creates log without optional fields (201)", async () => {
    const log = makeLog({ technique: null });
    const db = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([log]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/meditation")
      .send({ companyId: "company-1", sessionDate: "2026-09-09", durationMinutes: 10 });
    expect(res.status).toBe(201);
  });

  it("rejects missing companyId (400)", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/meditation")
      .send({ sessionDate: "2026-09-09", durationMinutes: 10 });
    expect(res.status).toBe(400);
  });

  it("rejects missing durationMinutes (400)", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/meditation")
      .send({ companyId: "company-1", sessionDate: "2026-09-09" });
    expect(res.status).toBe(400);
  });

  it("rejects durationMinutes < 1 (400)", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/meditation")
      .send({ companyId: "company-1", sessionDate: "2026-09-09", durationMinutes: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects invalid technique (400)", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/meditation")
      .send({ companyId: "company-1", sessionDate: "2026-09-09", durationMinutes: 10, technique: "unknown" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /meditation/:id
// ---------------------------------------------------------------------------

describe("DELETE /meditation/:id", () => {
  it("deletes a meditation log (204)", async () => {
    const selectChain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn().mockResolvedValue([makeLog()]),
    };
    selectChain.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnValue(selectChain);
    const deleteChain = {
      delete: vi.fn(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    deleteChain.delete.mockReturnValue(deleteChain);
    const db = {
      select: selectChain.select,
      from: selectChain.from,
      where: selectChain.where,
      delete: deleteChain.delete,
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/meditation/log-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when log not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/meditation/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 404 when log belongs to different user", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeLog({ userId: "other-user" })]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/meditation/log-1");
    expect(res.status).toBe(404);
  });
});

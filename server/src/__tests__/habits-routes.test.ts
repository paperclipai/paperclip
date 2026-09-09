import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { habitsRoutes } from "../routes/habits.js";
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
  app.use(habitsRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-09T00:00:00.000Z");

function makeHabit(overrides: Record<string, unknown> = {}) {
  return {
    id: "habit-1",
    companyId: "company-1",
    userId: "user-1",
    name: "Morning meditation",
    description: null,
    color: "#6366f1",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: "comp-1",
    habitId: "habit-1",
    companyId: "company-1",
    userId: "user-1",
    completionDate: "2026-09-09",
    notes: null,
    createdAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /habits
// ---------------------------------------------------------------------------

describe("GET /habits", () => {
  it("returns active habits (200)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([makeHabit()]),
    } as unknown as Db;

    const res = await request(createApp(db)).get("/habits?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.habits).toHaveLength(1);
  });

  it("rejects missing companyId (400)", async () => {
    const res = await request(createApp({} as unknown as Db)).get("/habits");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /habits
// ---------------------------------------------------------------------------

describe("POST /habits", () => {
  it("creates a habit (201)", async () => {
    const habit = makeHabit();
    const db = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([habit]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/habits")
      .send({ companyId: "company-1", name: "Morning meditation", color: "#6366f1" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Morning meditation");
  });

  it("rejects missing name (400)", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/habits")
      .send({ companyId: "company-1" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid color (400)", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/habits")
      .send({ companyId: "company-1", name: "Test", color: "red" });
    expect(res.status).toBe(400);
  });

  it("rejects missing companyId (400)", async () => {
    const res = await request(createApp({} as unknown as Db))
      .post("/habits")
      .send({ name: "Test" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /habits/:id
// ---------------------------------------------------------------------------

describe("PATCH /habits/:id", () => {
  it("updates a habit (200)", async () => {
    const updated = makeHabit({ name: "Evening run" });
    const selectChain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn().mockResolvedValue([makeHabit()]),
    };
    selectChain.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnValue(selectChain);
    const updateChain = {
      update: vi.fn(),
      set: vi.fn(),
      where: vi.fn(),
      returning: vi.fn().mockResolvedValue([updated]),
    };
    updateChain.update.mockReturnValue(updateChain);
    updateChain.set.mockReturnValue(updateChain);
    updateChain.where.mockReturnValue(updateChain);
    const db = {
      select: selectChain.select,
      from: selectChain.from,
      where: selectChain.where,
      update: updateChain.update,
      set: updateChain.set,
      returning: updateChain.returning,
    } as unknown as Db;

    const res = await request(createApp(db)).patch("/habits/habit-1").send({ name: "Evening run" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Evening run");
  });

  it("returns 404 when habit not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).patch("/habits/nonexistent").send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when habit belongs to different user", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeHabit({ userId: "other" })]),
    } as unknown as Db;

    const res = await request(createApp(db)).patch("/habits/habit-1").send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /habits/:id (soft-delete)
// ---------------------------------------------------------------------------

describe("DELETE /habits/:id", () => {
  it("soft-deletes a habit (204)", async () => {
    const selectChain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn().mockResolvedValue([makeHabit()]),
    };
    selectChain.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnValue(selectChain);
    const updateChain = {
      update: vi.fn(),
      set: vi.fn(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    updateChain.update.mockReturnValue(updateChain);
    updateChain.set.mockReturnValue(updateChain);
    const db = {
      select: selectChain.select,
      from: selectChain.from,
      where: selectChain.where,
      update: updateChain.update,
      set: updateChain.set,
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/habits/habit-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when habit not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/habits/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /habits/completions
// ---------------------------------------------------------------------------

describe("GET /habits/completions", () => {
  it("returns completions (200)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([makeCompletion()]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/habits/completions?companyId=company-1&from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(200);
    expect(res.body.completions).toHaveLength(1);
  });

  it("rejects missing companyId (400)", async () => {
    const res = await request(createApp({} as unknown as Db)).get(
      "/habits/completions?from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /habits/:habitId/complete
// ---------------------------------------------------------------------------

describe("POST /habits/:habitId/complete", () => {
  it("marks a habit complete (201)", async () => {
    const completion = makeCompletion();
    // First select: find habit; second select: no existing completion
    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return Promise.resolve([makeHabit()]);
        return Promise.resolve([]);
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([completion]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/habits/habit-1/complete")
      .send({ completionDate: "2026-09-09" });
    expect(res.status).toBe(201);
    expect(res.body.habitId).toBe("habit-1");
  });

  it("returns existing completion idempotently (200)", async () => {
    const completion = makeCompletion();
    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return Promise.resolve([makeHabit()]);
        return Promise.resolve([completion]);
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/habits/habit-1/complete")
      .send({ completionDate: "2026-09-09" });
    expect(res.status).toBe(200);
  });

  it("returns 404 when habit not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/habits/nonexistent/complete")
      .send({ completionDate: "2026-09-09" });
    expect(res.status).toBe(404);
  });

  it("rejects invalid completionDate (400)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeHabit()]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/habits/habit-1/complete")
      .send({ completionDate: "not-a-date" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /habits/:habitId/complete/:completionDate
// ---------------------------------------------------------------------------

describe("DELETE /habits/:habitId/complete/:completionDate", () => {
  it("unmarks a habit completion (204)", async () => {
    const selectChain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn().mockResolvedValue([makeHabit()]),
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

    const res = await request(createApp(db)).delete("/habits/habit-1/complete/2026-09-09");
    expect(res.status).toBe(204);
  });

  it("returns 404 when habit not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/habits/nonexistent/complete/2026-09-09");
    expect(res.status).toBe(404);
  });
});

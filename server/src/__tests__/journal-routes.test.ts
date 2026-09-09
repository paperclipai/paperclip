import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { journalRoutes } from "../routes/journal.js";
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
  app.use(journalRoutes(db));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-09-09T00:00:00.000Z");

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    companyId: "company-1",
    userId: "user-1",
    entryDate: "2026-09-09",
    title: "Good morning",
    body: "Feeling great today.",
    moodScore: 8,
    tags: ["gratitude"],
    isPrivate: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /journal
// ---------------------------------------------------------------------------

describe("GET /journal", () => {
  it("returns entries for the user (200)", async () => {
    const entry = makeEntry();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([entry]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/journal?companyId=company-1&from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].id).toBe("entry-1");
  });

  it("returns empty array when no entries (200)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).get(
      "/journal?companyId=company-1&from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
  });

  it("rejects missing companyId (400)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/journal?from=2026-09-01&to=2026-09-09",
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing from (400)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/journal?companyId=company-1&to=2026-09-09",
    );
    expect(res.status).toBe(400);
  });

  it("rejects date range exceeding 365 days (400)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db)).get(
      "/journal?companyId=company-1&from=2025-01-01&to=2026-12-31",
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /journal
// ---------------------------------------------------------------------------

describe("POST /journal", () => {
  it("creates a journal entry (201)", async () => {
    const entry = makeEntry();
    const db = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([entry]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/journal")
      .send({
        companyId: "company-1",
        entryDate: "2026-09-09",
        body: "Feeling great today.",
        title: "Good morning",
        moodScore: 8,
        tags: ["gratitude"],
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("entry-1");
  });

  it("creates entry without optional fields (201)", async () => {
    const entry = makeEntry({ title: null, moodScore: null, tags: [] });
    const db = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([entry]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .post("/journal")
      .send({
        companyId: "company-1",
        entryDate: "2026-09-09",
        body: "Minimal entry.",
      });
    expect(res.status).toBe(201);
  });

  it("rejects missing companyId (400)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/journal")
      .send({ entryDate: "2026-09-09", body: "Test." });
    expect(res.status).toBe(400);
  });

  it("rejects missing body (400)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/journal")
      .send({ companyId: "company-1", entryDate: "2026-09-09" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid moodScore (400)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/journal")
      .send({ companyId: "company-1", entryDate: "2026-09-09", body: "Test.", moodScore: 11 });
    expect(res.status).toBe(400);
  });

  it("rejects non-string tags (400)", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .post("/journal")
      .send({ companyId: "company-1", entryDate: "2026-09-09", body: "Test.", tags: [1, 2] });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /journal/:id
// ---------------------------------------------------------------------------

describe("PATCH /journal/:id", () => {
  it("updates a journal entry (200)", async () => {
    const entry = makeEntry({ body: "Updated body." });
    const selectChain = {
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn().mockResolvedValue([makeEntry()]),
    };
    selectChain.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnValue(selectChain);
    const updateChain = {
      update: vi.fn(),
      set: vi.fn(),
      where: vi.fn(),
      returning: vi.fn().mockResolvedValue([entry]),
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

    const res = await request(createApp(db))
      .patch("/journal/entry-1")
      .send({ body: "Updated body." });
    expect(res.status).toBe(200);
    expect(res.body.body).toBe("Updated body.");
  });

  it("returns 404 when entry not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/journal/nonexistent")
      .send({ body: "Updated." });
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different user", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeEntry({ userId: "other-user" })]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/journal/entry-1")
      .send({ body: "Updated." });
    expect(res.status).toBe(404);
  });

  it("rejects empty body string (400)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeEntry()]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .patch("/journal/entry-1")
      .send({ body: "   " });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /journal/:id
// ---------------------------------------------------------------------------

describe("DELETE /journal/:id", () => {
  it("deletes a journal entry (204)", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValueOnce([makeEntry()]),
      delete: vi.fn().mockReturnThis(),
    } as unknown as Db;
    (db as unknown as Record<string, ReturnType<typeof vi.fn>>)["where"]
      .mockResolvedValueOnce([makeEntry()])
      .mockResolvedValue(undefined);

    const selectChain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeEntry()]),
    };
    const deleteChain = {
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    const db2 = {
      select: selectChain.select,
      from: selectChain.from,
      where: selectChain.where,
      delete: deleteChain.delete,
    } as unknown as Db;
    selectChain.select.mockReturnValue(selectChain);
    selectChain.from.mockReturnValue(selectChain);
    deleteChain.delete.mockReturnValue(deleteChain);

    const res = await request(createApp(db2)).delete("/journal/entry-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when entry not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/journal/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry belongs to different user", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([makeEntry({ userId: "other-user" })]),
    } as unknown as Db;

    const res = await request(createApp(db)).delete("/journal/entry-1");
    expect(res.status).toBe(404);
  });
});

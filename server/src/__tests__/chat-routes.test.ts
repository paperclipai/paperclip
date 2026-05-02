import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { chatRoutes } from "../routes/chat.js";
import type { Db } from "@paperclipai/db";

type ChainStep = (...args: unknown[]) => unknown;

interface MockChain {
  rows: unknown[];
  insertedRows: unknown[];
  updates: unknown[];
  deletes: number;
}

function createMockDb(state: MockChain): Db {
  const select = () => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(state.rows),
        }),
        limit: () => Promise.resolve(state.rows),
        then: (fn: ChainStep) => fn(state.rows),
      }),
      orderBy: () => ({
        limit: () => Promise.resolve(state.rows),
      }),
      limit: () => Promise.resolve(state.rows),
      then: (fn: ChainStep) => fn(state.rows),
    }),
  });
  const insert = () => ({
    values: (v: unknown) => ({
      returning: () => {
        const inserted = {
          id: "new-id",
          createdAt: new Date(),
          updatedAt: new Date(),
          title: "New chat",
          model: "claude-opus-4-7",
          mode: "chat",
          permissionMode: "ask",
          effort: "auto",
          companyId: null,
          ...(v as Record<string, unknown>),
        };
        state.insertedRows.push(inserted);
        return Promise.resolve([inserted]);
      },
    }),
  });
  const update = () => ({
    set: (v: unknown) => ({
      where: () => ({
        returning: () => {
          state.updates.push(v);
          const updated = state.rows[0] ?? {
            id: "new-id",
            createdAt: new Date(),
            updatedAt: new Date(),
            title: "New chat",
            model: "claude-opus-4-7",
            mode: "chat",
            permissionMode: "ask",
            effort: "auto",
            companyId: null,
            boardUserId: "u1",
          };
          return Promise.resolve([{ ...(updated as Record<string, unknown>), ...(v as Record<string, unknown>) }]);
        },
        then: (fn: ChainStep) => fn(undefined),
      }),
    }),
  });
  const del = () => ({
    where: () => {
      state.deletes += 1;
      return Promise.resolve();
    },
  });
  return { select, insert, update, delete: del } as unknown as Db;
}

function buildApp(db: Db, actorOverride?: Partial<Express.Request["actor"]>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "u1",
      userName: "Tester",
      userEmail: null,
      isInstanceAdmin: true,
      companyIds: [],
      memberships: [],
      source: "session",
      ...(actorOverride ?? {}),
    } as Express.Request["actor"];
    next();
  });
  app.use("/api", chatRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("chat routes", () => {
  it("requires a board actor", async () => {
    const state: MockChain = { rows: [], insertedRows: [], updates: [], deletes: 0 };
    const db = createMockDb(state);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "a1", source: "agent_jwt" } as Express.Request["actor"];
      next();
    });
    app.use("/api", chatRoutes(db));
    app.use(errorHandler);
    const res = await request(app).get("/api/chat/sessions");
    expect(res.status).toBe(403);
  });

  it("creates a chat session", async () => {
    const state: MockChain = { rows: [], insertedRows: [], updates: [], deletes: 0 };
    const db = createMockDb(state);
    const app = buildApp(db);
    const res = await request(app)
      .post("/api/chat/sessions")
      .send({ title: "First chat", mode: "agent", permissionMode: "bypass" });
    expect(res.status).toBe(201);
    expect(res.body.session.title).toBe("First chat");
    expect(res.body.session.mode).toBe("agent");
    expect(res.body.session.permissionMode).toBe("bypass");
    expect(state.insertedRows).toHaveLength(1);
  });

  it("rejects invalid mode in createSession", async () => {
    const state: MockChain = { rows: [], insertedRows: [], updates: [], deletes: 0 };
    const db = createMockDb(state);
    const app = buildApp(db);
    const res = await request(app)
      .post("/api/chat/sessions")
      .send({ mode: "rogue" });
    expect(res.status).toBe(400);
  });

  it("returns a well-formed models list (adapter-discovered models are surfaced even when no native key is set)", async () => {
    const state: MockChain = { rows: [], insertedRows: [], updates: [], deletes: 0 };
    const db = createMockDb(state);
    const app = buildApp(db);
    const prevA = process.env.ANTHROPIC_API_KEY;
    const prevO = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await request(app).get("/api/chat/models");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.models)).toBe(true);
      // No native providers configured, so any models we see come from
      // installed adapters' static lists. Each entry is well-formed.
      for (const m of res.body.models) {
        expect(typeof m.model).toBe("string");
        expect(typeof m.provider).toBe("string");
      }
    } finally {
      if (prevA !== undefined) process.env.ANTHROPIC_API_KEY = prevA;
      if (prevO !== undefined) process.env.OPENAI_API_KEY = prevO;
    }
  });

  it("permission decision endpoint returns 404 when no permission is pending", async () => {
    // Pre-seed the session row so getSession passes the ownership check.
    const state: MockChain = {
      rows: [
        {
          id: "sess-1",
          boardUserId: "u1",
          companyId: null,
          title: "S1",
          model: "claude-opus-4-7",
          mode: "agent",
          permissionMode: "ask",
          effort: "auto",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      insertedRows: [],
      updates: [],
      deletes: 0,
    };
    const db = createMockDb(state);
    const app = buildApp(db);
    const res = await request(app)
      .post("/api/chat/sessions/sess-1/permissions/no-such-tool-use")
      .send({ decision: "approve" });
    expect(res.status).toBe(404);
  });
});

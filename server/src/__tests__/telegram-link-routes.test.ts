import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  telegramLinkRoutes,
  type ResolveTelegramCodeFn,
} from "../routes/telegram-link.js";

type UserRow = {
  id: string;
  telegramChatId: string | null;
  telegramUserId: string | null;
  telegramUsername: string | null;
};

function createDb(initial: UserRow) {
  const state: UserRow = { ...initial };
  return {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              telegramChatId: state.telegramChatId,
              telegramUsername: state.telegramUsername,
            },
          ]),
      }),
    }),
    update: () => ({
      set: (values: Partial<UserRow>) => ({
        where: () => {
          if (values.telegramChatId !== undefined) state.telegramChatId = values.telegramChatId ?? null;
          if (values.telegramUserId !== undefined) state.telegramUserId = values.telegramUserId ?? null;
          if (values.telegramUsername !== undefined) state.telegramUsername = values.telegramUsername ?? null;
          return Promise.resolve();
        },
      }),
    }),
    __state: state,
  } as unknown as Parameters<typeof telegramLinkRoutes>[0] & { __state: UserRow };
}

function createApp(opts: {
  actor: Express.Request["actor"];
  row: UserRow;
  resolveCode?: ResolveTelegramCodeFn;
}) {
  const db = createDb(opts.row);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = opts.actor;
    next();
  });
  app.use("/api", telegramLinkRoutes(db, { resolveCode: opts.resolveCode }));
  app.use(errorHandler);
  return { app, db: db as unknown as { __state: UserRow } };
}

describe.sequential("telegram link routes", () => {
  const baseRow: UserRow = {
    id: "user-1",
    telegramChatId: null,
    telegramUserId: null,
    telegramUsername: null,
  };

  it("returns linked=false when no chat is bound", async () => {
    const { app } = createApp({
      actor: { type: "board", userId: "user-1", source: "session" },
      row: { ...baseRow },
    });

    const res = await request(app).get("/api/users/me/telegram-link");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: false, telegramUsername: null });
  });

  it("links a telegram chat when the bot resolves the code", async () => {
    const { app, db } = createApp({
      actor: { type: "board", userId: "user-1", source: "session" },
      row: { ...baseRow },
      resolveCode: async (code) => {
        expect(code).toBe("123456");
        return { tgChatId: "999", tgUserId: "777", tgUsername: "dinar" };
      },
    });

    const res = await request(app)
      .post("/api/users/me/telegram-link")
      .send({ code: "123456" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: true, telegramUsername: "dinar" });
    expect(db.__state).toMatchObject({
      telegramChatId: "999",
      telegramUserId: "777",
      telegramUsername: "dinar",
    });
  });

  it("rejects invalid codes from validation", async () => {
    const { app } = createApp({
      actor: { type: "board", userId: "user-1", source: "session" },
      row: { ...baseRow },
      resolveCode: async () => {
        throw new Error("should not be called");
      },
    });

    const res = await request(app)
      .post("/api/users/me/telegram-link")
      .send({ code: "abc" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when bot reports an unknown code", async () => {
    const { app, db } = createApp({
      actor: { type: "board", userId: "user-1", source: "session" },
      row: { ...baseRow },
      resolveCode: async () => null,
    });

    const res = await request(app)
      .post("/api/users/me/telegram-link")
      .send({ code: "654321" });

    expect(res.status).toBe(400);
    expect(db.__state.telegramChatId).toBeNull();
  });

  it("unlinks the chat on DELETE", async () => {
    const { app, db } = createApp({
      actor: { type: "board", userId: "user-1", source: "session" },
      row: {
        ...baseRow,
        telegramChatId: "999",
        telegramUserId: "777",
        telegramUsername: "dinar",
      },
    });

    const res = await request(app).delete("/api/users/me/telegram-link");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: false, telegramUsername: null });
    expect(db.__state).toMatchObject({
      telegramChatId: null,
      telegramUserId: null,
      telegramUsername: null,
    });
  });

  it("rejects callers without a board session", async () => {
    const { app } = createApp({
      actor: { type: "none" },
      row: { ...baseRow },
    });

    const res = await request(app).get("/api/users/me/telegram-link");
    expect(res.status).toBe(401);
  });

  it("rejects agents without a userId", async () => {
    const { app } = createApp({
      actor: { type: "agent", agentId: "agent-1" },
      row: { ...baseRow },
    });

    const res = await request(app).get("/api/users/me/telegram-link");
    expect(res.status).toBe(401);
  });
});

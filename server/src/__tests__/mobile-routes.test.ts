import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createMobileChatStore } from "../mobile/chat-store.js";
import type { MobileAgentRow, MobileIssueRow } from "../mobile/types.js";
import { mobileRoutes } from "../routes/mobile.js";

const issues: MobileIssueRow[] = [
  {
    id: "issue-1",
    title: "Investigate stuck build",
    status: "running",
    priority: "high",
    assigneeName: "Ada",
    updatedAt: "2026-05-16T00:00:00.000Z",
    risk: null,
  },
  {
    id: "issue-2",
    title: "Review onboarding copy",
    status: "review_needed",
    priority: null,
    assigneeName: null,
    updatedAt: "2026-05-16T00:01:00.000Z",
    risk: "copy stale",
  },
  {
    id: "issue-3",
    title: "Unblock deploy",
    status: "blocked",
    priority: "urgent",
    assigneeName: "Grace",
    updatedAt: "2026-05-16T00:02:00.000Z",
    risk: "deploy blocked",
  },
  {
    id: "issue-4",
    title: "Close shipped feature",
    status: "done",
    priority: "low",
    assigneeName: "Linus",
    updatedAt: "2026-05-16T00:03:00.000Z",
    risk: null,
  },
];

const agents: MobileAgentRow[] = [
  {
    id: "agent-1",
    name: "Ada",
    role: "Engineer",
    status: "running",
    lastActivityAt: "2026-05-16T00:00:00.000Z",
    usageSummary: null,
  },
];

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/mobile",
    mobileRoutes({
      mobileToken: "secret-token",
      telegramUrl: "https://t.me/paperclip_test_bot",
      loadIssues: async () => issues,
      loadAgents: async () => agents,
      createChatStore: () =>
        createMobileChatStore({ now: () => new Date("2026-05-16T00:00:00.000Z") }),
    }),
  );
  return app;
};

describe("mobileRoutes", () => {
  it("rejects forged static mobile session cookies", async () => {
    await request(buildApp())
      .get("/api/mobile/summary")
      .set("Cookie", "mobile_session=1")
      .expect(401);
  });

  it("returns 401 for unauthenticated summary requests", async () => {
    const res = await request(buildApp()).get("/api/mobile/summary");

    expect(res.status).toBe(401);
  });

  it("sets a session cookie on successful login", async () => {
    const res = await request(buildApp())
      .post("/api/mobile/auth/login")
      .send({ token: "secret-token" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["set-cookie"][0]).toContain("mobile_session=");
    expect(res.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(res.headers["set-cookie"][0]).toContain("SameSite=Lax");
    expect(res.headers["set-cookie"][0]).toContain("Path=/api/mobile");
  });

  it("returns 401 when login token is wrong", async () => {
    const res = await request(buildApp())
      .post("/api/mobile/auth/login")
      .send({ token: "wrong-token" });

    expect(res.status).toBe(401);
  });

  it("invalidates the issued session on logout", async () => {
    const app = buildApp();
    const login = await request(app)
      .post("/api/mobile/auth/login")
      .send({ token: "secret-token" })
      .expect(200);
    const sessionCookie = login.headers["set-cookie"][0].split(";")[0];

    await request(app)
      .post("/api/mobile/auth/logout")
      .set("Cookie", sessionCookie)
      .expect(200, { ok: true });

    await request(app)
      .get("/api/mobile/summary")
      .set("Cookie", sessionCookie)
      .expect(401);
  });

  it("returns summary counts and telegramUrl after login", async () => {
    const agent = request.agent(buildApp());
    await agent.post("/api/mobile/auth/login").send({ token: "secret-token" }).expect(200);

    const res = await agent.get("/api/mobile/summary");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      health: "degraded",
      counts: {
        running: 1,
        reviewNeeded: 1,
        blocked: 1,
        done: 1,
      },
      latestReport: null,
      telegramUrl: "https://t.me/paperclip_test_bot",
    });
  });

  it("returns issues and agents loader data", async () => {
    const agent = request.agent(buildApp());
    await agent.post("/api/mobile/auth/login").send({ token: "secret-token" }).expect(200);

    await agent.get("/api/mobile/issues").expect(200, { issues });
    await agent.get("/api/mobile/agents").expect(200, { agents });
  });

  it("creates a chat user message and assistant placeholder timeline", async () => {
    const agent = request.agent(buildApp());
    await agent.post("/api/mobile/auth/login").send({ token: "secret-token" }).expect(200);

    const res = await agent
      .post("/api/mobile/chat/messages")
      .send({ text: "Summarize today" });

    expect(res.status).toBe(201);
    expect(res.body.message).toEqual({
      id: "mobile-chat-1",
      role: "user",
      text: "Summarize today",
      status: "sent",
      createdAt: "2026-05-16T00:00:00.000Z",
      replyToId: null,
      error: null,
    });
    expect(res.body.messages).toEqual([
      res.body.message,
      {
        id: "mobile-chat-2",
        role: "assistant",
        text: "헤르 전달 경로가 준비되면 이 요청을 처리합니다.",
        status: "sent",
        createdAt: "2026-05-16T00:00:00.000Z",
        replyToId: "mobile-chat-1",
        error: null,
      },
    ]);
  });

  it("returns 400 for empty chat text", async () => {
    const agent = request.agent(buildApp());
    await agent.post("/api/mobile/auth/login").send({ token: "secret-token" }).expect(200);

    const res = await agent.post("/api/mobile/chat/messages").send({ text: "   " });

    expect(res.status).toBe(400);
  });

  it("returns 404 when retrying a missing chat message", async () => {
    const agent = request.agent(buildApp());
    await agent.post("/api/mobile/auth/login").send({ token: "secret-token" }).expect(200);

    const res = await agent.post("/api/mobile/chat/messages/missing/retry");

    expect(res.status).toBe(404);
  });
});

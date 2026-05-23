import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  createInMemoryIdempotencyStore,
  idempotency,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_REPLAY_HEADER,
} from "../middleware/idempotency.js";

interface AppHarness {
  agent: ReturnType<typeof request>;
  callCount: () => number;
  app: express.Express;
}

interface CreateAppOptions {
  ttlMs?: number;
  now?: () => number;
  failNext?: number;
}

function createApp(opts: CreateAppOptions = {}): AppHarness {
  const store = createInMemoryIdempotencyStore({ now: opts.now });
  const app = express();
  app.use(express.json({
    verify: (req: express.Request, _res, buf: Buffer) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));

  let calls = 0;
  let failCountdown = opts.failNext ?? 0;

  app.post(
    "/companies/:companyId/agent-hires",
    idempotency({
      store,
      namespace: (req) => `agent-hires:${req.params.companyId}:test`,
      ttlMs: opts.ttlMs,
      now: opts.now,
    }),
    (req, res) => {
      calls += 1;
      if (failCountdown > 0) {
        failCountdown -= 1;
        res.status(500).json({ error: "boom" });
        return;
      }
      res.status(201).json({ agentId: `agent-${calls}`, body: req.body });
    },
  );

  return {
    agent: request(app),
    callCount: () => calls,
    app,
  };
}

describe("idempotency middleware", () => {
  it("passes through when no header is provided", async () => {
    const { agent, callCount } = createApp();
    const res = await agent.post("/companies/c1/agent-hires").send({ name: "a" });
    expect(res.status).toBe(201);
    expect(res.body.agentId).toBe("agent-1");
    expect(res.headers[IDEMPOTENCY_REPLAY_HEADER.toLowerCase()]).toBeUndefined();
    expect(callCount()).toBe(1);
  });

  it("replays the same 2xx response on duplicate key", async () => {
    const { agent, callCount } = createApp();
    const first = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-1")
      .send({ name: "a" });
    expect(first.status).toBe(201);
    expect(first.body.agentId).toBe("agent-1");

    const second = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-1")
      .send({ name: "a" });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers[IDEMPOTENCY_REPLAY_HEADER.toLowerCase()]).toBe("true");
    expect(callCount()).toBe(1);
  });

  it("rejects same key with a different body as 422", async () => {
    const { agent, callCount } = createApp();
    await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-2")
      .send({ name: "a" });

    const second = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-2")
      .send({ name: "b" });
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/different request body/i);
    expect(callCount()).toBe(1);
  });

  it("treats a different key with the same body as a fresh request", async () => {
    const { agent, callCount } = createApp();
    const first = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-A")
      .send({ name: "a" });
    const second = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-B")
      .send({ name: "a" });
    expect(first.body.agentId).toBe("agent-1");
    expect(second.body.agentId).toBe("agent-2");
    expect(callCount()).toBe(2);
  });

  it("treats an expired key as a fresh request", async () => {
    let clock = 1_000;
    const { agent, callCount } = createApp({
      ttlMs: 500,
      now: () => clock,
    });
    const first = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-1")
      .send({ name: "a" });
    expect(first.body.agentId).toBe("agent-1");

    clock += 600; // beyond TTL

    const second = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-1")
      .send({ name: "a" });
    expect(second.status).toBe(201);
    expect(second.body.agentId).toBe("agent-2");
    expect(second.headers[IDEMPOTENCY_REPLAY_HEADER.toLowerCase()]).toBeUndefined();
    expect(callCount()).toBe(2);
  });

  it("does not cache non-2xx responses", async () => {
    const { agent, callCount } = createApp({ failNext: 1 });
    const fail = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-fail")
      .send({ name: "a" });
    expect(fail.status).toBe(500);

    const retry = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "key-fail")
      .send({ name: "a" });
    expect(retry.status).toBe(201);
    expect(retry.body.agentId).toBe("agent-2");
    expect(retry.headers[IDEMPOTENCY_REPLAY_HEADER.toLowerCase()]).toBeUndefined();
    expect(callCount()).toBe(2);
  });

  it("rejects keys outside the 1-255 character range", async () => {
    const { agent } = createApp();
    const empty = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, " ")
      .send({ name: "a" });
    expect(empty.status).toBe(400);

    const tooLong = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "x".repeat(300))
      .send({ name: "a" });
    expect(tooLong.status).toBe(400);
  });

  it("isolates keys across namespaces (companies)", async () => {
    const { agent, callCount } = createApp();
    const a = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "shared")
      .send({ name: "a" });
    const b = await agent
      .post("/companies/c2/agent-hires")
      .set(IDEMPOTENCY_HEADER, "shared")
      .send({ name: "a" });
    expect(a.body.agentId).toBe("agent-1");
    expect(b.body.agentId).toBe("agent-2");
    expect(callCount()).toBe(2);
  });

  // Regression: reproduces the 2026-05-23 BizOps duplicate-hire incident.
  // Before this middleware, five retries on the same logical hire produced
  // five agents. With the middleware in place the handler runs once and the
  // other four requests replay the cached response.
  it("BizOps incident: five retries with the same key produce one agent", async () => {
    const { agent, callCount } = createApp();
    const body = { name: "Head of Engineering", role: "engineering" };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        agent
          .post("/companies/PLA/agent-hires")
          .set(IDEMPOTENCY_HEADER, "incident-2026-05-23")
          .send(body),
      ),
    );
    expect(callCount()).toBe(1);
    const agentIds = new Set(responses.map((r) => r.body.agentId));
    expect(agentIds.size).toBe(1);
    expect(agentIds.has("agent-1")).toBe(true);
    for (const res of responses) {
      expect(res.status).toBe(201);
    }
    const replayCount = responses.filter(
      (r) => r.headers[IDEMPOTENCY_REPLAY_HEADER.toLowerCase()] === "true",
    ).length;
    expect(replayCount).toBe(4);
  });
});

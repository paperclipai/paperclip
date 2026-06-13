import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  createInMemoryIdempotencyStore,
  idempotency,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_REPLAY_HEADER,
  type IdempotencyStore,
} from "../middleware/idempotency.js";

interface AppHarness {
  agent: ReturnType<typeof request>;
  callCount: () => number;
  app: express.Express;
  store: IdempotencyStore;
}

interface CreateAppOptions {
  ttlMs?: number;
  now?: () => number;
  failNext?: number;
  /**
   * Returns a promise that the handler awaits before responding.
   * Lets a test hold the leader in the "pending" state long enough
   * for follower requests to queue against it.
   */
  handlerGate?: () => Promise<void>;
  pendingWaitTimeoutMs?: number;
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
      pendingWaitTimeoutMs: opts.pendingWaitTimeoutMs,
    }),
    async (req, res) => {
      calls += 1;
      const callIndex = calls;
      if (opts.handlerGate) {
        await opts.handlerGate();
      }
      if (failCountdown > 0) {
        failCountdown -= 1;
        res.status(500).json({ error: "boom" });
        return;
      }
      res.status(201).json({ agentId: `agent-${callIndex}`, body: req.body });
    },
  );

  return {
    agent: request(app),
    callCount: () => calls,
    app,
    store,
  };
}

interface PendingProbe {
  status: "pending";
  waiters: unknown[];
}

function readPendingEntry(store: IdempotencyStore, storeKey: string): PendingProbe | null {
  const entry = store.get(storeKey) as PendingProbe | { status: "completed" } | undefined;
  if (entry && entry.status === "pending") return entry;
  return null;
}

async function waitForPendingWaiter(
  store: IdempotencyStore,
  storeKey: string,
  expectedWaiters: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = readPendingEntry(store, storeKey);
    if (pending && pending.waiters.length >= expectedWaiters) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(
    `Timed out waiting for ${expectedWaiters} pending waiter(s) on ${storeKey}; ` +
      `current store entry: ${JSON.stringify(store.get(storeKey))}`,
  );
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

  // The earlier BizOps-incident test uses a synchronous handler, so each
  // follower arrives at the middleware *after* the leader has already
  // populated a `completed` entry. That means the pending-waiter queue
  // is exercised zero times. The next three tests hold the leader inside
  // an awaited gate so a follower can queue against the real `pending`
  // entry, and `waitForPendingWaiter` blocks until the store actually
  // shows the follower on the waiter list — otherwise the test could
  // accidentally race against a completed entry and still pass.
  it("concurrent same-key follower waits on the in-flight leader", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { agent, callCount, store } = createApp({
      handlerGate: () => gate,
    });

    // Wrap in async IIFEs so the supertest request actually fires now
    // (supertest is thenable-lazy and won't send until awaited).
    const leader = (async () =>
      agent
        .post("/companies/c1/agent-hires")
        .set(IDEMPOTENCY_HEADER, "race-key")
        .send({ name: "race" }))();
    const follower = (async () =>
      agent
        .post("/companies/c1/agent-hires")
        .set(IDEMPOTENCY_HEADER, "race-key")
        .send({ name: "race" }))();

    await waitForPendingWaiter(store, "agent-hires:c1:test:race-key", 1);

    release!();

    const [leaderRes, followerRes] = await Promise.all([leader, follower]);

    expect(leaderRes.status).toBe(201);
    expect(followerRes.status).toBe(201);
    expect(followerRes.body).toEqual(leaderRes.body);
    expect(followerRes.headers[IDEMPOTENCY_REPLAY_HEADER.toLowerCase()]).toBe("true");
    expect(callCount()).toBe(1);
  });

  // When the in-flight leader fails (non-2xx), the middleware should not
  // cache the failure and concurrent followers should receive a 409 so
  // they can safely retry with the same key.
  it("concurrent follower receives 409 when the in-flight leader fails", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { agent, callCount, store } = createApp({
      handlerGate: () => gate,
      failNext: 1,
    });

    const leader = (async () =>
      agent
        .post("/companies/c1/agent-hires")
        .set(IDEMPOTENCY_HEADER, "race-fail")
        .send({ name: "race" }))();
    const follower = (async () =>
      agent
        .post("/companies/c1/agent-hires")
        .set(IDEMPOTENCY_HEADER, "race-fail")
        .send({ name: "race" }))();

    await waitForPendingWaiter(store, "agent-hires:c1:test:race-fail", 1);

    release!();

    const [leaderRes, followerRes] = await Promise.all([leader, follower]);
    expect(leaderRes.status).toBe(500);
    expect(followerRes.status).toBe(409);
    expect(followerRes.body.error).toMatch(/failed/i);
    // The leader's failed slot is evicted, so a fresh retry with the same
    // key after the dust settles runs the handler again.
    const retry = await agent
      .post("/companies/c1/agent-hires")
      .set(IDEMPOTENCY_HEADER, "race-fail")
      .send({ name: "race" });
    expect(retry.status).toBe(201);
    expect(callCount()).toBe(2);
  });

  // If the leader genuinely hangs longer than the configured pending-wait
  // timeout, the follower bails out with 409 instead of holding the
  // connection forever.
  it("concurrent follower times out with 409 when the leader hangs", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { agent, store } = createApp({
      handlerGate: () => gate,
      pendingWaitTimeoutMs: 25,
    });

    const leader = (async () =>
      agent
        .post("/companies/c1/agent-hires")
        .set(IDEMPOTENCY_HEADER, "race-slow")
        .send({ name: "race" }))();
    const followerPromise = (async () =>
      agent
        .post("/companies/c1/agent-hires")
        .set(IDEMPOTENCY_HEADER, "race-slow")
        .send({ name: "race" }))();

    await waitForPendingWaiter(store, "agent-hires:c1:test:race-slow", 1);

    const followerRes = await followerPromise;

    expect(followerRes.status).toBe(409);
    expect(followerRes.body.error).toMatch(/in flight/i);

    release!();
    await leader;
  });
});

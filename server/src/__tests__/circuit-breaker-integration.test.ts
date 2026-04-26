/**
 * Integration test suite for the adapter-level circuit breaker (ADR-0006).
 *
 * Exercises the **actually-shipped** CLI-157/158/159 surface:
 *   - In-memory circuit-breaker state machine (circuit-breaker.ts)
 *   - Admin HTTP routes for circuit reset and override-pause (admin-adapters.ts)
 *
 * CLI-180 follow-up: deferred-wake rows (issueId / scheduledAt columns),
 * agents.status = "quarantined" DB mutation, and issues.executionState.quarantineHold
 * stamping are NOT asserted here — those land with CLI-180.
 *
 * Guard (a): DB-backed tests are skipped when embedded Postgres is unavailable.
 * Guard (b): preserved as-is — resolves true now that admin-adapters.ts ships with CLI-159.
 *            When CLI-180 merges, relax this guard back to a pure-import check in that PR.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// ---------------------------------------------------------------------------
// Guard (a): embedded Postgres
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

// ---------------------------------------------------------------------------
// Guard (b): circuit-breaker module + admin routes (CLI-157/159)
// ---------------------------------------------------------------------------
type CircuitBreakerModule = typeof import("../adapters/circuit-breaker.js");
let circuitBreakerModule: CircuitBreakerModule | null = null;
let adminAdapterRoutesSupported = false;
const quarantineHoldSupported = "quarantineHold" in issues;
try {
  circuitBreakerModule = await import("../adapters/circuit-breaker.js");
} catch {
  // Module not yet implemented (CLI-157 still pending). Tests will be skipped.
}
try {
  await import("../routes/admin-adapters.js");
  adminAdapterRoutesSupported = true;
} catch {
  // Later circuit-breaker tasks wire the admin reset route.
}

const circuitBreakerSupported =
  circuitBreakerModule !== null && quarantineHoldSupported && adminAdapterRoutesSupported;

if (!circuitBreakerSupported) {
  console.warn(
    "Skipping circuit-breaker state-machine tests: circuit-breaker module or admin routes (CLI-157/159) not yet shipped.",
    { circuitBreakerModuleLoaded: circuitBreakerModule !== null, adminAdapterRoutesSupported, quarantineHoldSupported },
  );
}

// ---------------------------------------------------------------------------
// Mock heartbeatService.reconcileCircuitQuarantine so admin-adapters.ts
// doesn't need a running heartbeat worker.
// ---------------------------------------------------------------------------
const mockReconcile = vi.hoisted(() =>
  vi.fn(async () => ({ clearedHolds: 0, promoted: [], stalePromoted: 0 })),
);
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    reconcileCircuitQuarantine: mockReconcile,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers shared across sections
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof createDb>;

/** Alias — assertions are narrowed inside each test. */
const cb = circuitBreakerModule!;

const ADAPTER_TYPE = "claude_local";
const ADAPTER_CONFIG = { model: "haiku-test" };

function makeCircuitKey() {
  return cb.buildCircuitKey({ adapterType: ADAPTER_TYPE, adapterConfig: ADAPTER_CONFIG });
}

/** Trip the circuit by recording N failures (uses current time offsets so they land within the window). */
function tripCircuit(key: string, count = 3) {
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    cb.recordCircuitExecutionFailure({
      key,
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
      adapterFailureReason: "adapter_protocol_error",
      now: new Date(base - (count - i) * 100),
    });
  }
}

// ---------------------------------------------------------------------------
// Section A — pure in-memory state machine (no DB required)
// ---------------------------------------------------------------------------

const describeStateMachine = circuitBreakerSupported ? describe : describe.skip;

describeStateMachine("circuit-breaker state machine", () => {
  beforeEach(() => {
    cb.resetAllCircuits();
  });

  afterEach(() => {
    cb.resetAllCircuits();
  });

  // ── buildCircuitKey ──────────────────────────────────────────────────────

  it("buildCircuitKey: process adapter produces a config-hashed key", () => {
    const key = cb.buildCircuitKey({
      adapterType: "process",
      adapterConfig: { command: "/bin/echo" },
    });
    expect(key).toMatch(/^process:config:[0-9a-f]{12}$/);
  });

  it("buildCircuitKey: http adapter produces a config-hashed key", () => {
    const key = cb.buildCircuitKey({
      adapterType: "http",
      adapterConfig: { url: "http://localhost:4000" },
    });
    expect(key).toMatch(/^http:config:[0-9a-f]{12}$/);
  });

  it("buildCircuitKey: other adapter types produce a stable module key", () => {
    const key1 = cb.buildCircuitKey({ adapterType: "claude_local", adapterConfig: { model: "x" } });
    const key2 = cb.buildCircuitKey({ adapterType: "claude_local", adapterConfig: { model: "y" } });
    expect(key1).toBe("claude_local:module");
    expect(key1).toBe(key2); // config doesn't affect the key for non-process/http types
  });

  it("buildCircuitKey: null/empty adapterType falls back to unknown:module", () => {
    const key = cb.buildCircuitKey({ adapterType: null, adapterConfig: {} });
    expect(key).toBe("unknown:module");
  });

  it("buildCircuitKey: same input always yields same key (stability)", () => {
    const a = cb.buildCircuitKey({ adapterType: "process", adapterConfig: { command: "/bin/sh" } });
    const b2 = cb.buildCircuitKey({ adapterType: "process", adapterConfig: { command: "/bin/sh" } });
    expect(a).toBe(b2);
  });

  // ── toRouteKey ───────────────────────────────────────────────────────────

  it("toRouteKey: encodes a circuit key to a URL-safe base64url string", () => {
    const key = makeCircuitKey();
    const routeKey = cb.toRouteKey(key);
    expect(routeKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // Roundtrip: decoding the base64url should recover the original key.
    expect(Buffer.from(routeKey, "base64url").toString("utf8")).toBe(key);
  });

  // ── getCircuitExecutionDecision ──────────────────────────────────────────

  it("getCircuitExecutionDecision: Closed circuit → execute action", () => {
    const decision = cb.getCircuitExecutionDecision({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(decision.action).toBe("execute");
    expect(decision.state).toBe("Closed");
    expect(decision.resumeAt).toBeNull();
  });

  it("getCircuitExecutionDecision: Open circuit → defer action with resumeAt", () => {
    const key = makeCircuitKey();
    tripCircuit(key);

    const decision = cb.getCircuitExecutionDecision({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(decision.action).toBe("defer");
    expect(decision.state).toBe("Open");
    expect(decision.resumeAt).toBeTruthy();
  });

  it("getCircuitExecutionDecision: Half-Open → probe on first call, defer on second (lease)", () => {
    const key = makeCircuitKey();
    tripCircuit(key);
    cb.advanceToHalfOpen(key);

    const first = cb.getCircuitExecutionDecision({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(first.action).toBe("probe");
    expect(first.state).toBe("Half-Open");

    const second = cb.getCircuitExecutionDecision({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(second.action).toBe("defer");
    expect(second.state).toBe("Half-Open");
    expect(second.resumeAt).toBeNull(); // deferred pending probe result, not by time
  });

  // ── recordCircuitExecutionFailure ────────────────────────────────────────

  it("recordCircuitExecutionFailure: non-counting reason does not trip the circuit", () => {
    const key = makeCircuitKey();
    // adapter_quarantined has countsTowardBreaker=false; even repeated calls should not open.
    for (let i = 0; i < 10; i++) {
      cb.recordCircuitExecutionFailure({
        key,
        adapterType: ADAPTER_TYPE,
        adapterConfig: ADAPTER_CONFIG,
        adapterFailureReason: "adapter_quarantined",
      });
    }
    expect(cb.getCircuitState(key)?.state).toBe("Closed");
  });

  it("recordCircuitExecutionFailure: reaching threshold opens the circuit", () => {
    const key = makeCircuitKey();
    const threshold = cb.getEffectiveThreshold(key);
    expect(threshold).toBeGreaterThanOrEqual(1);

    tripCircuit(key, threshold);

    const state = cb.getCircuitState(key);
    expect(state?.state).toBe("Open");
    expect(state?.resumeAt).toBeTruthy();
    expect(state?.lastFailureReason).toBe("adapter_protocol_error");
  });

  // ── recordCircuitExecutionSuccess (probe) ────────────────────────────────

  it("recordCircuitExecutionSuccess: successful probe closes the circuit and halves effectiveThreshold", () => {
    const key = makeCircuitKey();
    const defaultThreshold = cb.getEffectiveThreshold(key);
    tripCircuit(key, defaultThreshold);
    cb.advanceToHalfOpen(key);

    cb.recordCircuitExecutionSuccess({
      key,
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });

    const state = cb.getCircuitState(key);
    expect(state?.state).toBe("Closed");
    // Probe success halves the threshold (floor 1).
    expect(state?.effectiveThreshold).toBe(Math.max(1, Math.ceil(defaultThreshold / 2)));
  });

  // ── Re-trip threshold halving (within reTripGrace) ───────────────────────

  it("re-trip within reTripGrace requires only the halved threshold to open the circuit again", () => {
    const key = makeCircuitKey();
    const defaultThreshold = cb.getEffectiveThreshold(key);

    // First trip → probe succeeds → Closed (effectiveThreshold halved).
    tripCircuit(key, defaultThreshold);
    cb.advanceToHalfOpen(key);
    cb.recordCircuitExecutionSuccess({ key, adapterType: ADAPTER_TYPE, adapterConfig: ADAPTER_CONFIG });
    expect(cb.getCircuitState(key)?.state).toBe("Closed");

    const halvedThreshold = Math.max(1, Math.ceil(defaultThreshold / 2));
    expect(cb.getEffectiveThreshold(key)).toBe(halvedThreshold);

    // Re-trip within grace: only halvedThreshold failures needed.
    tripCircuit(key, halvedThreshold);
    expect(cb.getCircuitState(key)?.state).toBe("Open");
  });

  // ── Re-trip threshold reset after grace ──────────────────────────────────

  it("advancePastReTripGrace: threshold resets to default after grace period elapses", () => {
    const key = makeCircuitKey();
    const defaultThreshold = cb.getEffectiveThreshold(key);

    // Trip → probe succeeds → effectiveThreshold halved.
    tripCircuit(key, defaultThreshold);
    cb.advanceToHalfOpen(key);
    cb.recordCircuitExecutionSuccess({ key, adapterType: ADAPTER_TYPE, adapterConfig: ADAPTER_CONFIG });
    expect(cb.getEffectiveThreshold(key)).toBeLessThan(defaultThreshold);

    // Advance past the re-trip grace period.
    cb.advancePastReTripGrace(key);

    expect(cb.getEffectiveThreshold(key)).toBe(defaultThreshold);
  });

  // ── resetCircuit ─────────────────────────────────────────────────────────

  it("resetCircuit: closes an Open circuit and resets state fields", () => {
    const key = makeCircuitKey();
    tripCircuit(key);
    expect(cb.getCircuitState(key)?.state).toBe("Open");

    const result = cb.resetCircuit(key);
    expect(result?.state).toBe("Closed");
    expect(result?.resumeAt).toBeNull();
    expect(result?.openedAt).toBeNull();
    expect(result?.lastFailureReason).toBeNull();
    expect(cb.getCircuitState(key)?.state).toBe("Closed");
  });

  // ── getAdapterQuarantineBadgeState ───────────────────────────────────────

  it("getAdapterQuarantineBadgeState: returns null for Closed circuit", () => {
    const badge = cb.getAdapterQuarantineBadgeState({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(badge).toBeNull();
  });

  it("getAdapterQuarantineBadgeState: returns { resumeAt } for Open circuit", () => {
    const key = makeCircuitKey();
    tripCircuit(key);

    const badge = cb.getAdapterQuarantineBadgeState({
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
    });
    expect(badge).not.toBeNull();
    expect(badge?.resumeAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Section B — admin HTTP routes (require embedded Postgres + admin-adapters)
// ---------------------------------------------------------------------------

const describeAdminRoutes =
  circuitBreakerSupported && embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping circuit-breaker admin route tests: embedded Postgres unavailable — ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeAdminRoutes("circuit-breaker admin routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cb-admin-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    cb.resetAllCircuits();
  });

  afterEach(async () => {
    cb.resetAllCircuits();
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  /** Seed a company + agent and trip the circuit so the route has something to act on. */
  async function seedOpenCircuit() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "CB Admin Route Co",
      issuePrefix: `CBR${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CircuitTestAgent",
      role: "engineer",
      status: "running",
      adapterType: ADAPTER_TYPE,
      adapterConfig: ADAPTER_CONFIG,
      runtimeConfig: {},
      permissions: {},
    });

    const circuitKey = makeCircuitKey();
    tripCircuit(circuitKey);
    expect(cb.getCircuitState(circuitKey)?.state).toBe("Open");

    return { companyId, agentId, circuitKey, routeKey: cb.toRouteKey(circuitKey) };
  }

  /** Build an express app wired to adminAdapterRoutes with a synthetic actor. */
  async function createApp(actor: Express.Request["actor"]) {
    const { adminAdapterRoutes } = await import("../routes/admin-adapters.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api/admin/adapters", adminAdapterRoutes(db));
    return app;
  }

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "local-board",
    userName: null,
    userEmail: null,
    source: "local_implicit",
    isInstanceAdmin: true,
    companyIds: [],
    memberships: [],
  };

  // ── POST /:key/reset ──────────────────────────────────────────────────────

  it("board actor can reset an Open circuit; circuit becomes Closed; audit row written", async () => {
    const { companyId, circuitKey, routeKey } = await seedOpenCircuit();
    const app = await createApp(boardActor);

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/reset`)
      .send({ reason: "fix deployed", actor: "local-board" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe("Closed");
    expect(cb.getCircuitState(circuitKey)?.state).toBe("Closed");
    expect(mockReconcile).toHaveBeenCalledWith({ circuitKey });

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("circuit_reset");
    expect(rows[0]?.actorId).toBe("local-board");
    expect(rows[0]?.details).toMatchObject({
      action: "reset",
      key: circuitKey,
      reason: "fix deployed",
      outcome: "applied",
      oldState: { state: "Open" },
      newState: { state: "Closed" },
    });
  });

  it("agent actor reset attempt is rejected with HTTP 403; circuit remains Open; rejection audited", async () => {
    const { companyId, agentId, circuitKey, routeKey } = await seedOpenCircuit();
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/reset`)
      .send({ reason: "self-rescue attempt", actor: agentId });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agent actors cannot manually release adapter quarantine" });
    expect(cb.getCircuitState(circuitKey)?.state).toBe("Open");
    expect(mockReconcile).not.toHaveBeenCalled();

    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("circuit_reset");
    expect(rows[0]?.actorId).toBe(agentId);
    expect(rows[0]?.details).toMatchObject({
      action: "reset",
      reason: "self-rescue attempt",
      outcome: "rejected_agent_actor",
      oldState: null,
      newState: null,
    });
  });

  it("reset with missing reason body field is rejected with HTTP 400", async () => {
    const { routeKey } = await seedOpenCircuit();
    const app = await createApp(boardActor);

    const res = await request(app)
      .post(`/api/admin/adapters/${routeKey}/reset`)
      .send({ actor: "local-board" }); // no reason

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });
});

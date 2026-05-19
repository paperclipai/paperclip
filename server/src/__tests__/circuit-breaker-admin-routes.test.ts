/**
 * CLI-159 — Circuit Breaker admin routes: agent-actor rejection, board-actor
 * success, and audit-row content.
 *
 * Routes under test:
 *   GET  /api/adapters/quarantine
 *   POST /api/adapters/:type/circuit-breaker/force-quarantine
 *   POST /api/adapters/:type/circuit-breaker/reset
 *   GET  /api/adapters/circuit-breaker/audit
 */

import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn((_file: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (typeof callback === "function") callback(null, "", "");
    return { kill: vi.fn(), on: vi.fn() };
  }),
  listAdapterPlugins: vi.fn(() => []),
  addAdapterPlugin: vi.fn(),
  removeAdapterPlugin: vi.fn(),
  getAdapterPluginByType: vi.fn(() => undefined),
  getAdapterPluginsDir: vi.fn(() => "/tmp/cb-admin-routes-test"),
  getDisabledAdapterTypes: vi.fn(() => []),
  setAdapterDisabled: vi.fn(),
  loadExternalAdapterPackage: vi.fn(),
  buildExternalAdapters: vi.fn(async () => []),
  reloadExternalAdapter: vi.fn(),
  getUiParserSource: vi.fn(),
  getOrExtractUiParserSource: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("../services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: mocks.listAdapterPlugins,
  addAdapterPlugin: mocks.addAdapterPlugin,
  removeAdapterPlugin: mocks.removeAdapterPlugin,
  getAdapterPluginByType: mocks.getAdapterPluginByType,
  getAdapterPluginsDir: mocks.getAdapterPluginsDir,
  getDisabledAdapterTypes: mocks.getDisabledAdapterTypes,
  setAdapterDisabled: mocks.setAdapterDisabled,
}));
vi.mock("../adapters/plugin-loader.js", () => ({
  buildExternalAdapters: mocks.buildExternalAdapters,
  loadExternalAdapterPackage: mocks.loadExternalAdapterPackage,
  getUiParserSource: mocks.getUiParserSource,
  getOrExtractUiParserSource: mocks.getOrExtractUiParserSource,
  reloadExternalAdapter: mocks.reloadExternalAdapter,
}));

// ── Dynamic imports (after mocks) ─────────────────────────────────────────

let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;
let circuitBreaker: typeof import("../adapters/circuit-breaker.js");

// ── Actor helpers ─────────────────────────────────────────────────────────

const instanceAdmin: Express.Request["actor"] = {
  type: "board",
  userId: "instance-admin",
  userName: null,
  userEmail: null,
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: [],
  memberships: [],
};

const boardMember: Express.Request["actor"] = {
  type: "board",
  userId: "board-user",
  userName: null,
  userEmail: null,
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-abc"],
  memberships: [{ companyId: "company-abc", membershipRole: "admin", status: "active" }],
};

/** Board actor with no company membership — assertBoardOrgAccess rejects this. */
const boardNoOrg: Express.Request["actor"] = {
  type: "board",
  userId: "board-no-org",
  userName: null,
  userEmail: null,
  source: "session",
  isInstanceAdmin: false,
  companyIds: [],
  memberships: [],
};

function agentActor(agentId = "agent-test-id"): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId: "company-abc",
    runId: "run-test-id",
  };
}

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

// ── Test setup ────────────────────────────────────────────────────────────

beforeAll(async () => {
  [{ adapterRoutes }, { errorHandler }, circuitBreaker] = await Promise.all([
    import("../routes/adapters.js"),
    import("../middleware/index.js"),
    import("../adapters/circuit-breaker.js"),
  ]);
}, 20_000);

afterEach(() => {
  circuitBreaker._resetForTesting();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("GET /api/adapters/quarantine", () => {
  it("returns empty quarantine object when no circuits are active", async () => {
    const res = await request(createApp(instanceAdmin)).get("/api/adapters/quarantine");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ quarantine: {} });
  });

  it("lists a quarantined adapter after force-quarantine", async () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin-user");
    const res = await request(createApp(instanceAdmin)).get("/api/adapters/quarantine");
    expect(res.status).toBe(200);
    expect(res.body.quarantine).toHaveProperty("copilot_local");
    expect(res.body.quarantine.copilot_local.phase).toBe("Open");
  });

  it("is accessible to board members with org access", async () => {
    const res = await request(createApp(boardMember)).get("/api/adapters/quarantine");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/adapters/:type/circuit-breaker/force-quarantine", () => {
  it("allows a board actor to force-quarantine an adapter", async () => {
    const res = await request(createApp(instanceAdmin))
      .post("/api/adapters/copilot_local/circuit-breaker/force-quarantine")
      .send({ reason: "test quarantine" });

    expect(res.status).toBe(200);
    expect(res.body.quarantined).toBe(true);
    expect(res.body.adapterType).toBe("copilot_local");
    expect(typeof res.body.auditId).toBe("string");
  });

  it("rejects an agent actor with HTTP 403 (ADR-0006 §9 / CLI-91)", async () => {
    const agentId = "agent-that-wants-to-clear-own-quarantine";
    const res = await request(createApp(agentActor(agentId)))
      .post("/api/adapters/copilot_local/circuit-breaker/force-quarantine")
      .send({ reason: "self-clearing own quarantine" });

    expect(res.status).toBe(403);
    expect(res.body.rejectionReason).toBe("actor_is_agent");
    expect(typeof res.body.auditId).toBe("string");
  });

  it("writes an audit row for agent-actor rejections (rejection is auditable)", async () => {
    await request(createApp(agentActor("sneaky-agent")))
      .post("/api/adapters/copilot_local/circuit-breaker/force-quarantine")
      .send({});

    const audit = circuitBreaker.getAuditLog();
    const row = audit.find(
      (r) => r.action === "force_quarantine" && r.outcome === "rejected" && r.actorId === "sneaky-agent",
    );
    expect(row).toBeDefined();
    expect(row!.rejectionReason).toBe("actor_is_agent");
    expect(row!.actorType).toBe("agent");
  });

  it("writes an audit row with actor details for board-actor success", async () => {
    await request(createApp(instanceAdmin))
      .post("/api/adapters/claude_local/circuit-breaker/force-quarantine")
      .send({ reason: "drill" });

    const audit = circuitBreaker.getAuditLog();
    const row = audit.find((r) => r.action === "force_quarantine" && r.outcome === "success");
    expect(row).toBeDefined();
    expect(row!.actorType).toBe("board");
    expect(row!.actorId).toBe("instance-admin");
    expect(row!.adapterType).toBe("claude_local");
  });

  it("transitions adapter to Open phase after successful force-quarantine", async () => {
    await request(createApp(instanceAdmin))
      .post("/api/adapters/copilot_local/circuit-breaker/force-quarantine")
      .send({});

    const state = circuitBreaker.getCircuitState("copilot_local");
    expect(state?.phase).toBe("Open");
  });

  // CLI-176 regression: board actor without org access must not mutate state
  it("CLI-176: board actor without org access gets 403 with no auditId and no state mutation", async () => {
    const res = await request(createApp(boardNoOrg))
      .post("/api/adapters/copilot_local/circuit-breaker/force-quarantine")
      .send({ reason: "unauthorized attempt" });

    expect(res.status).toBe(403);
    // No auditId on board-auth failure (only agent rejections get auditId)
    expect(res.body.auditId).toBeUndefined();
    // Circuit state must NOT have been mutated
    expect(circuitBreaker.getCircuitState("copilot_local")).toBeNull();
    // No success audit row written
    const audit = circuitBreaker.getAuditLog();
    expect(audit.find((r) => r.action === "force_quarantine" && r.outcome === "success")).toBeUndefined();
  });
});

describe("POST /api/adapters/:type/circuit-breaker/reset", () => {
  it("allows a board actor to reset a quarantined adapter to Closed", async () => {
    // First quarantine
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin-user");
    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Open");

    const res = await request(createApp(instanceAdmin))
      .post("/api/adapters/copilot_local/circuit-breaker/reset")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.reset).toBe(true);
    expect(res.body.phase).toBe("Closed");
    expect(typeof res.body.auditId).toBe("string");
  });

  it("rejects an agent actor with HTTP 403 (ADR-0006 §9 / CLI-91)", async () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin-user");

    const res = await request(createApp(agentActor("compromised-agent")))
      .post("/api/adapters/copilot_local/circuit-breaker/reset")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.rejectionReason).toBe("actor_is_agent");
    // Adapter should remain Open — agent could not clear quarantine
    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Open");
  });

  it("writes an audit row for agent-actor reset rejections (rejection is auditable)", async () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin-user");

    await request(createApp(agentActor("bad-agent"))).post(
      "/api/adapters/copilot_local/circuit-breaker/reset",
    ).send({});

    const audit = circuitBreaker.getAuditLog();
    const row = audit.find(
      (r) => r.action === "reset" && r.outcome === "rejected" && r.actorId === "bad-agent",
    );
    expect(row).toBeDefined();
    expect(row!.rejectionReason).toBe("actor_is_agent");
    expect(row!.adapterType).toBe("copilot_local");
  });

  it("writes an audit row with force=true when force is sent", async () => {
    circuitBreaker.forceQuarantine("claude_local", "board", "admin-user");

    await request(createApp(instanceAdmin))
      .post("/api/adapters/claude_local/circuit-breaker/reset")
      .send({ force: true });

    const audit = circuitBreaker.getAuditLog();
    const row = audit.find((r) => r.action === "reset" && r.outcome === "success");
    expect(row?.details?.force).toBe(true);
  });

  it("transitions adapter to Closed phase after successful reset", async () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin-user");
    await request(createApp(instanceAdmin))
      .post("/api/adapters/copilot_local/circuit-breaker/reset")
      .send({});

    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Closed");
  });

  // CLI-176 regression: board actor without org access must not mutate state
  it("CLI-176: board actor without org access gets 403 with no auditId and state remains Open", async () => {
    // Pre-condition: adapter is quarantined
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin-user");
    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Open");

    const res = await request(createApp(boardNoOrg))
      .post("/api/adapters/copilot_local/circuit-breaker/reset")
      .send({});

    expect(res.status).toBe(403);
    // No auditId on board-auth failure
    expect(res.body.auditId).toBeUndefined();
    // Adapter must remain Open — unauthorized board user could not clear quarantine
    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Open");
    // No success audit row for reset written
    const audit = circuitBreaker.getAuditLog();
    expect(audit.find((r) => r.action === "reset" && r.outcome === "success")).toBeUndefined();
  });
});

describe("GET /api/adapters/circuit-breaker/audit", () => {
  it("returns audit log to instance admins", async () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin-user");

    const res = await request(createApp(instanceAdmin)).get(
      "/api/adapters/circuit-breaker/audit",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.auditLog)).toBe(true);
    expect(res.body.auditLog.length).toBeGreaterThan(0);
  });

  it("rejects non-instance-admin board users with 403", async () => {
    const res = await request(createApp(boardMember)).get(
      "/api/adapters/circuit-breaker/audit",
    );
    expect(res.status).toBe(403);
  });
});

describe("circuit-breaker state machine (unit)", () => {
  it("starts in Closed phase by default", () => {
    expect(circuitBreaker.getCircuitState("copilot_local")).toBeNull();
  });

  it("transitions to Open after forceQuarantine by board actor", () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin");
    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Open");
  });

  it("transitions to Closed after resetBreaker by board actor", () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin");
    circuitBreaker.resetBreaker("copilot_local", "board", "admin");
    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Closed");
  });

  it("rejects forceQuarantine from agent actor", () => {
    const { allowed } = circuitBreaker.forceQuarantine("copilot_local", "agent", "agent-id");
    expect(allowed).toBe(false);
    // State was NOT created / remains null because no board actor touched it
    expect(circuitBreaker.getCircuitState("copilot_local")).toBeNull();
  });

  it("rejects resetBreaker from agent actor (ADR-0006 §9)", () => {
    circuitBreaker.forceQuarantine("copilot_local", "board", "admin");
    const { allowed } = circuitBreaker.resetBreaker("copilot_local", "agent", "bad-agent");
    expect(allowed).toBe(false);
    expect(circuitBreaker.getCircuitState("copilot_local")?.phase).toBe("Open");
  });

  it("halves effectiveNBurst on re-trip within grace window", () => {
    const cb = circuitBreaker;
    cb.configure({ ...cb.getConfig(), reTripGraceMs: 60_000 });

    cb.forceQuarantine("copilot_local", "board", "admin"); // trip 1
    cb.resetBreaker("copilot_local", "board", "admin"); // release

    // Re-trip immediately (within grace window)
    cb.forceQuarantine("copilot_local", "board", "admin");

    const state = cb.getCircuitState("copilot_local");
    // effectiveNBurst should be halved from default (3 → 2)
    expect(state?.effectiveNBurst).toBeLessThan(cb.getConfig().nBurst);
  });
});

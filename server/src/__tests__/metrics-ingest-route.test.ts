import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { metricsIngestRoutes, type MetricsIngestOptions } from "../routes/metrics-ingest.js";
import {
  CONCURRENT_RUN_BLOCKED_METRIC,
  ISOLATED_RUN_STARTED_METRIC,
  UNKNOWN_AGENT_ID,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";

afterEach(() => {
  __resetMetricsForTest();
});

function buildApp(opts: {
  actor?: Partial<Express.Request["actor"]>;
  resolveKnownAgentIds?: MetricsIngestOptions["resolveKnownAgentIds"];
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Express.Request["actor"] }).actor = {
      type: "agent",
      agentId: "agent-a",
      companyId: "company-1",
      source: "agent_key",
      ...opts.actor,
    };
    next();
  });
  app.use("/api", metricsIngestRoutes(undefined, { resolveKnownAgentIds: opts.resolveKnownAgentIds }));
  app.use(errorHandler);
  return app;
}

const ENDPOINT = "/api/metrics/claude-k8s/concurrent-run-blocked";

describe(`POST ${ENDPOINT}`, () => {
  it("records a roster member with its real agent_id and reflects it on /metrics", async () => {
    const app = buildApp({
      actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
      resolveKnownAgentIds: async () => new Set(["agent-a"]),
    });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ agentId: "agent-a", reason: "live_job_for_active_run" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      recorded: true,
      labels: { agent_id: "agent-a", reason: "live_job_for_active_run", isolation_mode: "unknown" },
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_active_run",isolation_mode="unknown"} 1`,
    );
  });

  it("records the bounded isolation_mode label and keeps high-card ids off /metrics", async () => {
    const app = buildApp({
      actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
      resolveKnownAgentIds: async () => new Set(["agent-a"]),
    });

    const res = await request(app)
      .post(ENDPOINT)
      .send({
        agentId: "agent-a",
        reason: "shared_mode_serialized",
        isolationMode: "shared",
        // High-cardinality identifiers are accepted (for the structured log) but
        // MUST NOT become Prometheus labels.
        isolationKey: "shared:company-1:agent-a",
        taskKey: "issue-123",
        sessionId: "sess-abc-456",
      });

    expect(res.status).toBe(202);
    expect(res.body.labels).toEqual({
      agent_id: "agent-a",
      reason: "shared_mode_serialized",
      isolation_mode: "shared",
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="shared_mode_serialized",isolation_mode="shared"} 1`,
    );
    expect(body).not.toContain("issue-123");
    expect(body).not.toContain("sess-abc-456");
  });

  it("coerces an out-of-allow-list isolation_mode to \"unknown\"", async () => {
    const app = buildApp({
      actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
      resolveKnownAgentIds: async () => new Set(["agent-a"]),
    });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ agentId: "agent-a", reason: "live_job_for_active_run", isolationMode: "isolated" });

    expect(res.status).toBe(202);
    expect(res.body.labels.isolation_mode).toBe("unknown");
  });

  it("normalizes a synthetic unknown agent id to agent_id=\"unknown\"", async () => {
    const app = buildApp({
      actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
      resolveKnownAgentIds: async () => new Set(["agent-a"]),
    });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ agentId: "ghost-agent-not-in-roster", reason: "live_job_for_unknown_run" });

    expect(res.status).toBe(202);
    expect(res.body.labels.agent_id).toBe(UNKNOWN_AGENT_ID);

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",reason="live_job_for_unknown_run",isolation_mode="unknown"} 1`,
    );
  });

  it("scopes the roster to the caller's company (cross-company id collapses to unknown)", async () => {
    const rosterByCompany: Record<string, Set<string>> = {
      "company-1": new Set(["agent-a"]),
      "company-2": new Set(["agent-x"]),
    };
    const app = buildApp({
      actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
      resolveKnownAgentIds: async (companyId) => rosterByCompany[companyId] ?? new Set(),
    });

    // agent-x belongs to company-2, but the caller is in company-1.
    const res = await request(app)
      .post(ENDPOINT)
      .send({ agentId: "agent-x", reason: "live_job_for_active_run" });

    expect(res.status).toBe(202);
    expect(res.body.labels.agent_id).toBe(UNKNOWN_AGENT_ID);
  });

  it("records the fail-closed unknown_isolation_blocked reason through the HTTP layer", async () => {
    const app = buildApp({
      actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
      resolveKnownAgentIds: async () => new Set(["agent-a"]),
    });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ agentId: "agent-a", reason: "unknown_isolation_blocked", isolationMode: "workspace" });

    expect(res.status).toBe(202);
    expect(res.body.labels).toEqual({
      agent_id: "agent-a",
      reason: "unknown_isolation_blocked",
      isolation_mode: "workspace",
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="unknown_isolation_blocked",isolation_mode="workspace"} 1`,
    );
  });

  it("rejects unauthenticated callers", async () => {
    const app = buildApp({ actor: { type: "none", source: "none" } });

    const res = await request(app)
      .post(ENDPOINT)
      .send({ agentId: "agent-a", reason: "live_job_for_active_run" });

    expect(res.status).toBe(401);
  });
});

const ISOLATED_ENDPOINT = "/api/metrics/claude-k8s/isolated-run-started";

describe(`POST ${ISOLATED_ENDPOINT}`, () => {
  it("records an isolated start with bounded agent_id and isolation_mode", async () => {
    const app = buildApp({
      actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
      resolveKnownAgentIds: async () => new Set(["agent-a"]),
    });

    const res = await request(app)
      .post(ISOLATED_ENDPOINT)
      .send({
        agentId: "agent-a",
        isolationMode: "workspace",
        isolationKey: "workspace:company-1:agent-a:ws-1",
        taskKey: "issue-777",
        sessionId: "sess-zzz",
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      recorded: true,
      labels: { agent_id: "agent-a", isolation_mode: "workspace" },
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${ISOLATED_RUN_STARTED_METRIC}{agent_id="agent-a",isolation_mode="workspace"} 1`,
    );
    expect(body).not.toContain("issue-777");
    expect(body).not.toContain("sess-zzz");
  });

  it("rejects unauthenticated callers", async () => {
    const app = buildApp({ actor: { type: "none", source: "none" } });

    const res = await request(app)
      .post(ISOLATED_ENDPOINT)
      .send({ agentId: "agent-a", isolationMode: "workspace" });

    expect(res.status).toBe(401);
  });
});

// The BLO-12212/BLO-12505 acceptance criterion is that an isolated block points
// to the conflicting isolation key / task / session. The metric labels
// deliberately omit those high-card ids, so the ONLY place they surface is the
// structured guard-decision log line. These tests assert the log is actually
// emitted with the right fields and mapping — a regression that drops or
// mis-maps a field would otherwise pass every other test in this suite.
describe("guard-decision log carries the high-card conflicting ids", () => {
  it("emits isolation_key/task_key/session_id on the blocked-route log line", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      const app = buildApp({
        actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
        resolveKnownAgentIds: async () => new Set(["agent-a"]),
      });

      const res = await request(app)
        .post(ENDPOINT)
        .send({
          agentId: "agent-a",
          reason: "shared_mode_serialized",
          isolationMode: "shared",
          isolationKey: "shared:company-1:agent-a",
          taskKey: "issue-123",
          sessionId: "sess-abc-456",
        });

      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith(
        {
          event: "k8s_concurrent_run_blocked",
          decision: "blocked",
          agent_id: "agent-a",
          reason: "shared_mode_serialized",
          isolation_mode: "shared",
          isolation_key: "shared:company-1:agent-a",
          task_key: "issue-123",
          session_id: "sess-abc-456",
        },
        "k8s guard: dispatch blocked",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("emits isolation_key/task_key/session_id on the isolated-start log line", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      const app = buildApp({
        actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
        resolveKnownAgentIds: async () => new Set(["agent-a"]),
      });

      const res = await request(app)
        .post(ISOLATED_ENDPOINT)
        .send({
          agentId: "agent-a",
          isolationMode: "workspace",
          isolationKey: "workspace:company-1:agent-a:ws-1",
          taskKey: "issue-777",
          sessionId: "sess-zzz",
        });

      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith(
        {
          event: "k8s_isolated_run_started",
          decision: "allowed",
          agent_id: "agent-a",
          isolation_mode: "workspace",
          isolation_key: "workspace:company-1:agent-a:ws-1",
          task_key: "issue-777",
          session_id: "sess-zzz",
        },
        "k8s guard: isolated dispatch allowed",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("null-coalesces empty-string conflicting ids (readString rejects \"\")", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      const app = buildApp({
        actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
        resolveKnownAgentIds: async () => new Set(["agent-a"]),
      });

      const res = await request(app)
        .post(ENDPOINT)
        .send({
          agentId: "agent-a",
          reason: "live_job_for_active_run",
          // Empty strings are present-but-blank: readString() must reject them so
          // they null-coalesce, not leak "" into the structured log.
          isolationKey: "",
          taskKey: "",
          sessionId: "",
        });

      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith(
        {
          event: "k8s_concurrent_run_blocked",
          decision: "blocked",
          agent_id: "agent-a",
          reason: "live_job_for_active_run",
          isolation_mode: "unknown",
          isolation_key: null,
          task_key: null,
          session_id: null,
        },
        "k8s guard: dispatch blocked",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("null-coalesces the conflicting ids when the request omits them", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    try {
      const app = buildApp({
        actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
        resolveKnownAgentIds: async () => new Set(["agent-a"]),
      });

      const res = await request(app)
        .post(ENDPOINT)
        .send({ agentId: "agent-a", reason: "live_job_for_active_run" });

      expect(res.status).toBe(202);
      expect(spy).toHaveBeenCalledWith(
        {
          event: "k8s_concurrent_run_blocked",
          decision: "blocked",
          agent_id: "agent-a",
          reason: "live_job_for_active_run",
          isolation_mode: "unknown",
          isolation_key: null,
          task_key: null,
          session_id: null,
        },
        "k8s guard: dispatch blocked",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// A logging failure must never fail the request: the metric increment has
// already landed and the adapter blocks on the 202 to advance. The guard-
// decision log is best-effort and its throw is swallowed in the route.
describe("guard-decision logging is best-effort", () => {
  it("still returns 202 (and records the metric) when the blocked log throws", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {
      throw new Error("logger transport down");
    });
    try {
      const app = buildApp({
        actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
        resolveKnownAgentIds: async () => new Set(["agent-a"]),
      });

      const res = await request(app)
        .post(ENDPOINT)
        .send({ agentId: "agent-a", reason: "live_job_for_active_run", isolationMode: "shared" });

      expect(res.status).toBe(202);
      expect(res.body.recorded).toBe(true);

      const { body } = await renderMetrics();
      expect(body).toContain(
        `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_active_run",isolation_mode="shared"} 1`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("still returns 202 when BOTH logger.info and the logger.warn fallback throw", async () => {
    // Exercises the nested catch in logGuardDecision: the breadcrumb warn is
    // itself guarded, so a transport that is fully down (both paths throw) must
    // still not turn the 202 into a 500.
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {
      throw new Error("logger transport down");
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("logger transport still down");
    });
    try {
      const app = buildApp({
        actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
        resolveKnownAgentIds: async () => new Set(["agent-a"]),
      });

      const res = await request(app)
        .post(ENDPOINT)
        .send({ agentId: "agent-a", reason: "live_job_for_active_run", isolationMode: "shared" });

      expect(res.status).toBe(202);
      expect(res.body.recorded).toBe(true);
      expect(warnSpy).toHaveBeenCalled();

      const { body } = await renderMetrics();
      expect(body).toContain(
        `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_active_run",isolation_mode="shared"} 1`,
      );
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("still returns 202 (and records the metric) when the isolated-start log throws", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {
      throw new Error("logger transport down");
    });
    try {
      const app = buildApp({
        actor: { type: "agent", agentId: "agent-a", companyId: "company-1" },
        resolveKnownAgentIds: async () => new Set(["agent-a"]),
      });

      const res = await request(app)
        .post(ISOLATED_ENDPOINT)
        .send({ agentId: "agent-a", isolationMode: "workspace" });

      expect(res.status).toBe(202);
      expect(res.body.recorded).toBe(true);

      const { body } = await renderMetrics();
      expect(body).toContain(
        `${ISOLATED_RUN_STARTED_METRIC}{agent_id="agent-a",isolation_mode="workspace"} 1`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

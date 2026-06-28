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

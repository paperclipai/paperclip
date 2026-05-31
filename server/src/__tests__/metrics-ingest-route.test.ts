import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { metricsIngestRoutes, type MetricsIngestOptions } from "../routes/metrics-ingest.js";
import {
  CONCURRENT_RUN_BLOCKED_METRIC,
  UNKNOWN_AGENT_ID,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import { errorHandler } from "../middleware/index.js";

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
      labels: { agent_id: "agent-a", reason: "live_job_for_active_run" },
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="agent-a",reason="live_job_for_active_run"} 1`,
    );
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
      `${CONCURRENT_RUN_BLOCKED_METRIC}{agent_id="${UNKNOWN_AGENT_ID}",reason="live_job_for_unknown_run"} 1`,
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

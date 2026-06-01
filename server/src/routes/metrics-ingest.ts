/**
 * @fileoverview Adapter-originated metric ingestion (BLO-8328).
 *
 * The `claude_k8s` adapter reports a dispatch refusal here; the control plane
 * applies the cardinality guardrail and increments the prom-client counter so
 * the event is exposed on `/metrics`. Routing the increment through the Service
 * (rather than an in-process call) is what makes the counter visible under the
 * HA api/worker split: the increment lands on a scraped api-tier pod and
 * Prometheus sums across pod endpoints.
 *
 * @module server/routes/metrics-ingest
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertAuthenticated } from "./authz.js";
import { recordConcurrentRunBlocked } from "../services/metrics.js";
import { getActiveAgentIds } from "../services/agent-roster.js";

const EMPTY_ROSTER: ReadonlySet<string> = new Set();

export interface MetricsIngestOptions {
  /**
   * Resolve the active agent roster for a company. Injected so the route is
   * testable without a live DB. Defaults to the cached DB-backed resolver.
   */
  resolveKnownAgentIds?: (companyId: string) => Promise<ReadonlySet<string>>;
}

export function metricsIngestRoutes(db?: Db, opts: MetricsIngestOptions = {}) {
  const router = Router();
  const resolveKnownAgentIds =
    opts.resolveKnownAgentIds
    ?? (db ? (companyId: string) => getActiveAgentIds(db, companyId) : undefined);

  // POST /api/metrics/claude-k8s/concurrent-run-blocked
  router.post("/metrics/claude-k8s/concurrent-run-blocked", async (req, res) => {
    assertAuthenticated(req);

    const body = (req.body ?? {}) as {
      agentId?: unknown;
      reason?: unknown;
      companyId?: unknown;
    };
    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    const reason = typeof body.reason === "string" ? body.reason : undefined;

    // Scope the roster to the caller's company so an agent cannot attribute a
    // refusal to an agent_id outside its own company. Board callers may name the
    // company explicitly. Any unresolved company → empty roster → agent_id
    // collapses to "unknown" via the guardrail.
    const companyId =
      req.actor.type === "agent"
        ? req.actor.companyId
        : typeof body.companyId === "string"
          ? body.companyId
          : undefined;

    let knownAgentIds: ReadonlySet<string> = EMPTY_ROSTER;
    if (resolveKnownAgentIds && companyId) {
      knownAgentIds = await resolveKnownAgentIds(companyId);
    }

    const labels = recordConcurrentRunBlocked({ agentId, reason, knownAgentIds });
    res.status(202).json({ recorded: true, labels });
  });

  return router;
}

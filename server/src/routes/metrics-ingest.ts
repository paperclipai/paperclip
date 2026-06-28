/**
 * @fileoverview Adapter-originated metric ingestion (BLO-8328, BLO-12212/BLO-12505).
 *
 * The K8s adapter reports a dispatch refusal (or an isolated start) here; the
 * control plane applies the cardinality guardrail and increments the prom-client
 * counters so the event is exposed on `/metrics`. Routing the increment through
 * the Service (rather than an in-process call) is what makes the counter visible
 * under the HA api/worker split: the increment lands on a scraped api-tier pod
 * and Prometheus sums across pod endpoints.
 *
 * Isolation audit (BLO-12212): the blocked event carries the bounded
 * `isolationMode` (emitted as a metric label) plus the high-cardinality
 * conflicting `isolationKey`/`taskKey`/`sessionId`. The latter three are
 * deliberately NOT metric labels — they are emitted on a structured
 * guard-decision log line so operators can pinpoint the conflicting
 * task/session without inflating series cardinality (the onprem-k8s alerts in
 * PR Blockcast/onprem-k8s#936 group by them but degrade to empty labels when the
 * control plane omits them).
 *
 * @module server/routes/metrics-ingest
 */

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertAuthenticated } from "./authz.js";
import {
  recordConcurrentRunBlocked,
  recordIsolatedRunStarted,
} from "../services/metrics.js";
import { getActiveAgentIds } from "../services/agent-roster.js";
import { logger } from "../middleware/logger.js";

const EMPTY_ROSTER: ReadonlySet<string> = new Set();

export interface MetricsIngestOptions {
  /**
   * Resolve the active agent roster for a company. Injected so the route is
   * testable without a live DB. Defaults to the cached DB-backed resolver.
   */
  resolveKnownAgentIds?: (companyId: string) => Promise<ReadonlySet<string>>;
}

/** Coerce an unknown body field to a non-empty string, else undefined. */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The high-cardinality conflicting identifiers that ride on the structured
 * guard-decision log line (never on metric labels). Pulled into one helper so
 * the blocked and isolated-start records stay structurally aligned as fields
 * are added, and the null-coalescing is expressed once.
 */
function readGuardIds(body: {
  isolationKey?: unknown;
  taskKey?: unknown;
  sessionId?: unknown;
}): { isolation_key: string | null; task_key: string | null; session_id: string | null } {
  return {
    isolation_key: readString(body.isolationKey) ?? null,
    task_key: readString(body.taskKey) ?? null,
    session_id: readString(body.sessionId) ?? null,
  };
}

/**
 * Emit a structured guard-decision log. Logging is best-effort: the metric
 * increment has already landed by the time we get here, and the adapter blocks
 * on the route's 202 to advance to the next dispatch. A transient logger
 * failure (transport write error, buffer overflow) must therefore never turn
 * the 202 into a 500 — swallow any throw and keep the response path intact.
 *
 * The swallow is deliberately broad (it also masks a programming error such as
 * a non-serializable field), so we leave a breadcrumb via `logger.warn`. That
 * warn is itself guarded: if the transport is genuinely down, even the warn can
 * throw, and we must still not fail the request.
 */
function logGuardDecision(fields: Record<string, unknown>, msg: string): void {
  try {
    logger.info(fields, msg);
  } catch (err) {
    try {
      logger.warn(
        { event: "guard_decision_log_failed", err: String(err) },
        "k8s guard: guard-decision log emission failed (swallowed)",
      );
    } catch {
      // Transport is down for both paths: a logging failure must not fail the request.
    }
  }
}

export function metricsIngestRoutes(db?: Db, opts: MetricsIngestOptions = {}) {
  const router = Router();
  const resolveKnownAgentIds =
    opts.resolveKnownAgentIds
    ?? (db ? (companyId: string) => getActiveAgentIds(db, companyId) : undefined);

  /**
   * Resolve the roster for the caller. Scope it to the caller's company so an
   * agent cannot attribute a refusal to an agent_id outside its own company.
   * Board callers may name the company explicitly. Any unresolved company →
   * empty roster → agent_id collapses to "unknown" via the guardrail.
   */
  async function resolveRoster(
    actor: Express.Request["actor"],
    bodyCompanyId: unknown,
  ): Promise<ReadonlySet<string>> {
    const companyId = actor.type === "agent" ? actor.companyId : readString(bodyCompanyId);
    if (resolveKnownAgentIds && companyId) {
      return resolveKnownAgentIds(companyId);
    }
    return EMPTY_ROSTER;
  }

  // POST /api/metrics/claude-k8s/concurrent-run-blocked
  router.post("/metrics/claude-k8s/concurrent-run-blocked", async (req, res) => {
    assertAuthenticated(req);

    const body = (req.body ?? {}) as {
      agentId?: unknown;
      reason?: unknown;
      companyId?: unknown;
      isolationMode?: unknown;
      isolationKey?: unknown;
      taskKey?: unknown;
      sessionId?: unknown;
    };
    const agentId = readString(body.agentId);
    const reason = readString(body.reason);
    const isolationMode = readString(body.isolationMode);

    const knownAgentIds = await resolveRoster(req.actor, body.companyId);

    const labels = recordConcurrentRunBlocked({ agentId, reason, isolationMode, knownAgentIds });

    // Structured guard-decision log: carries the high-cardinality conflicting
    // identifiers that are intentionally absent from the metric labels, so the
    // operator can pinpoint the conflicting task/session (BLO-12212 AC: isolated
    // blocks point to the conflicting isolation key/task/session).
    logGuardDecision(
      {
        event: "k8s_concurrent_run_blocked",
        decision: "blocked",
        agent_id: labels.agent_id,
        reason: labels.reason,
        isolation_mode: labels.isolation_mode,
        ...readGuardIds(body),
      },
      "k8s guard: dispatch blocked",
    );

    res.status(202).json({ recorded: true, labels });
  });

  // POST /api/metrics/claude-k8s/isolated-run-started
  router.post("/metrics/claude-k8s/isolated-run-started", async (req, res) => {
    assertAuthenticated(req);

    const body = (req.body ?? {}) as {
      agentId?: unknown;
      companyId?: unknown;
      isolationMode?: unknown;
      isolationKey?: unknown;
      taskKey?: unknown;
      sessionId?: unknown;
    };
    const agentId = readString(body.agentId);
    const isolationMode = readString(body.isolationMode);

    const knownAgentIds = await resolveRoster(req.actor, body.companyId);

    const labels = recordIsolatedRunStarted({ agentId, isolationMode, knownAgentIds });

    logGuardDecision(
      {
        event: "k8s_isolated_run_started",
        decision: "allowed",
        agent_id: labels.agent_id,
        isolation_mode: labels.isolation_mode,
        ...readGuardIds(body),
      },
      "k8s guard: isolated dispatch allowed",
    );

    res.status(202).json({ recorded: true, labels });
  });

  return router;
}

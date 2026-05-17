/**
 * Phase 4A-S4 B2 (LET-367): REST endpoints for the billing-cap monitor.
 *
 *   GET  /companies/:companyId/sandbox/billing-cap/status
 *   POST /companies/:companyId/sandbox/billing-cap/operator-toggle
 *
 * The GET is mounted on top of the existing `/api/companies/:id/sandbox/*`
 * namespace so the B3 panel reads from one provider-status surface. No new
 * public REST area is introduced.
 *
 * Operator-toggle authorisation matches the rest of the sandbox surface:
 *   - Board role required (board-or-org access).
 *   - Local-implicit board / instance-admin can always operate.
 *   - Non-board agents and viewer-role users are read-only (canOperate=false
 *     in the GET payload + 403 from the POST).
 */

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess } from "./authz.js";
import {
  DrizzleBillingCapStore,
  type BillingCapMonitor,
  type BillingCapStore,
  type SandboxProviderDescriptor,
  type SandboxProviderLeaseSummary,
  buildStatusView,
} from "../services/sandbox/billing-cap/index.js";
import { listSandboxLeasesForCompany } from "../services/sandbox/queries.js";
import { listSandboxProviders } from "../services/sandbox-provider-runtime.js";

export interface SandboxBillingCapRouteDeps {
  monitor: BillingCapMonitor;
  /**
   * Resolves the provider descriptor that B3 renders. Caller supplies it so
   * the secret-store glue stays out of this route module.
   */
  resolveProviderDescriptor: (companyId: string, provider: string) => Promise<SandboxProviderDescriptor>;
  /** Reads the `SANDBOX_PROVIDER_ALLOW_LIVE` env-gate. */
  isAllowLive: () => boolean;
  /** Override default provider key (`e2b`). */
  provider?: string;
  /** Override the persistence store — tests inject `InMemoryBillingCapStore`. */
  store?: BillingCapStore;
}

const DEFAULT_PROVIDER = "e2b";
const RECENT_LEASE_LIMIT = 10;

function isBoardActor(req: Request): boolean {
  return req.actor.type === "board";
}

function isBoardOperator(req: Request, companyId: string): boolean {
  if (!isBoardActor(req)) return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const memberships = Array.isArray(req.actor.memberships) ? req.actor.memberships : [];
  const membership = memberships.find((m) => m.companyId === companyId);
  if (!membership || membership.status !== "active") return false;
  return membership.membershipRole !== "viewer";
}

function actorLabelFor(req: Request): string {
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit") return "operator:local";
    return `operator:${req.actor.userId ?? "unknown"}`;
  }
  if (req.actor.type === "agent") {
    return `agent:${req.actor.agentId ?? "unknown"}`;
  }
  return "operator:unknown";
}

function summariseLease(row: {
  id: string;
  status: string;
  acquiredAt: Date;
  releasedAt: Date | null;
  metadata: Record<string, unknown> | null;
  heartbeatRunId: string | null;
}): SandboxProviderLeaseSummary {
  const end = row.releasedAt ?? null;
  const durationSeconds = end
    ? Math.max(0, Math.round((end.getTime() - row.acquiredAt.getTime()) / 1000))
    : null;
  return {
    id: row.id,
    state: row.status,
    startedAt: row.acquiredAt.toISOString(),
    endedAt: end ? end.toISOString() : null,
    durationSeconds,
    runtimeCostEstimateUsd: null, // populated downstream by the monitor's counter store
    agentId: typeof row.metadata?.agentId === "string" ? (row.metadata.agentId as string) : null,
    agentName: typeof row.metadata?.agentName === "string" ? (row.metadata.agentName as string) : null,
    runId: row.heartbeatRunId,
  };
}

export function sandboxBillingCapRoutes(db: Db, deps: SandboxBillingCapRouteDeps) {
  const router = Router();
  const provider = deps.provider ?? DEFAULT_PROVIDER;
  const store: BillingCapStore = deps.store ?? new DrizzleBillingCapStore(db);

  router.get("/companies/:companyId/sandbox/billing-cap/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const knownProviderKeys = listSandboxProviders().map((p) => p.provider);
    const [state, recentLeases, recentEvents, providerDescriptor] = await Promise.all([
      store.load(companyId, provider),
      listSandboxLeasesForCompany(
        db,
        companyId,
        { provider },
        { knownProviderKeys, limit: RECENT_LEASE_LIMIT },
      ),
      store.listEvents(companyId, provider, { limit: 20 }),
      deps.resolveProviderDescriptor(companyId, provider),
    ]);

    const view = buildStatusView({
      now: new Date(),
      provider: providerDescriptor,
      state,
      recentEvents,
      recentLeases: recentLeases.map((lease) =>
        summariseLease({
          id: lease.id,
          status: lease.status,
          acquiredAt: lease.acquiredAt,
          releasedAt: lease.releasedAt ?? null,
          metadata: lease.metadata ?? null,
          heartbeatRunId: lease.heartbeatRunId ?? null,
        }),
      ),
      allowLive: deps.isAllowLive(),
      previewOnly: true,
      canOperate: isBoardOperator(req, companyId),
      operatorLockedReason: isBoardOperator(req, companyId)
        ? null
        : isBoardActor(req)
          ? "Viewer access is read-only on the sandbox kill-switch"
          : "Board role required to operate the sandbox kill-switch",
    });

    res.json(view);
  });

  router.post(
    "/companies/:companyId/sandbox/billing-cap/operator-toggle",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (!isBoardOperator(req, companyId)) {
        throw forbidden("Board role with non-viewer membership required");
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.enable !== "boolean") {
        throw badRequest("'enable' must be a boolean", { field: "enable" });
      }
      const reason =
        typeof body.reason === "string" && body.reason.trim().length > 0
          ? body.reason.trim()
          : null;
      if (!reason) {
        throw unprocessable("'reason' is required for sandbox kill-switch flips", {
          field: "reason",
        });
      }

      const current = await store.load(companyId, provider);
      if (current && current.operatorToggleEnabled === body.enable) {
        throw conflict("Operator toggle is already in the requested state", {
          currentlyEnabled: current.operatorToggleEnabled,
        });
      }

      const { state, event } = await deps.monitor.flipOperatorToggle({
        companyId,
        enable: body.enable,
        reason,
        actorLabel: actorLabelFor(req),
      });

      // Reenable-refused returns a 409 — the monitor records the refusal but
      // does not flip state.
      if (event.kind === "reenable_refused") {
        throw conflict("Re-enable refused: monthly hard-cap breach on record", {
          kind: "reenable_refused",
        });
      }

      logger.info(
        {
          companyId,
          actor: actorLabelFor(req),
          enable: body.enable,
          eventId: event.id,
        },
        "sandbox billing-cap operator toggle flipped",
      );

      res.json({
        ok: true,
        currentlyEnabled: state.operatorToggleEnabled,
      });
    },
  );

  return router;
}

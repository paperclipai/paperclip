/**
 * Phase 4A-2 (LET-314) / Phase 4A-S6 (LET-352): /api/sandbox REST + SSE
 * read-models.
 *
 * Preview / stub only. This surface exposes truthful lease / provider /
 * artifact status for future Command Center consumers without invoking any
 * real Docker run/build/pull/start/stop. No real container isolation has
 * shipped yet — see ADR LET-328 for the buy-vs-build decision. The only
 * mutation-like endpoint is `POST /sandbox/preview/validate`, which is
 * explicitly tagged preview-only and runs the in-memory provider scaffold's
 * `validateConfig` (no host action).
 *
 * Every JSON response and every SSE payload carries:
 *   - `previewOnly: true`     — invariant marker, never `false` in this phase.
 *   - `notice: SANDBOX_PREVIEW_NOTICE` — the same banner copy the UI shows.
 *   - `adr: { id, href, summary }` — pointer to the LET-328 ADR.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  isBuiltinSandboxProvider,
  listSandboxProviderDescriptors,
  listSandboxProviders,
  sandboxProviderPreviewOnlyMap as getSandboxProviderPreviewOnlyMap,
  sandboxProviderStatusMap as getSandboxProviderStatusMap,
  validateSandboxProviderConfig,
  type SandboxProviderStatusSnapshot,
} from "../services/sandbox-provider-runtime.js";
import {
  getSandboxLeaseForCompany,
  listSandboxLeasesForCompany,
} from "../services/sandbox/queries.js";
import {
  redactSandboxEventPayload,
  toSandboxLeaseReadModel,
  type SandboxLeaseReadModel,
} from "../services/sandbox/read-model.js";
import {
  publishSandboxEvent,
  subscribeCompanySandboxEvents,
  type SandboxEvent,
} from "../services/sandbox/events.js";
import {
  evaluateEgressIntent,
  InvalidEgressIntentError,
  type EgressDecision,
  type EgressIntent,
} from "../services/sandbox/egress-policy.js";
import {
  parseSandboxNetworkPolicy,
  InvalidSandboxNetworkPolicyError,
  DEFAULT_SANDBOX_NETWORK_POLICY,
  type SandboxNetworkPolicy,
} from "../services/sandbox/network-policy.js";
import {
  redactEgressIntent,
  summarizeEgressAudit,
  type RedactedEgressIntent,
} from "../services/sandbox/egress-redaction.js";
import {
  ENVIRONMENT_LEASE_STATUSES,
  type EnvironmentLeaseStatus,
} from "@paperclipai/shared";
import { assertCompanyAccess } from "./authz.js";

/**
 * Machine-readable error codes surfaced under `details.code` for callers
 * that need to branch on classification without parsing free-text errors.
 */
export const SANDBOX_ERROR_CODES = {
  PROVIDER_UNSUPPORTED: "SANDBOX_PROVIDER_UNSUPPORTED",
  PROVIDER_DISABLED: "SANDBOX_PROVIDER_DISABLED",
  PREVIEW_ONLY: "SANDBOX_PREVIEW_ONLY",
  INVALID_LEASE_TRANSITION: "SANDBOX_INVALID_LEASE_TRANSITION",
  QUOTA_REJECTED: "SANDBOX_QUOTA_REJECTED",
  POLICY_REJECTED: "SANDBOX_POLICY_REJECTED",
  ARTIFACT_MISSING: "SANDBOX_ARTIFACT_MISSING",
  LEASE_NOT_FOUND: "SANDBOX_LEASE_NOT_FOUND",
  INVALID_QUERY: "SANDBOX_INVALID_QUERY",
  EGRESS_POLICY_INVALID: "SANDBOX_EGRESS_POLICY_INVALID",
  EGRESS_INTENT_INVALID: "SANDBOX_EGRESS_INTENT_INVALID",
} as const;

const SSE_KEEPALIVE_MS = 25_000;

/**
 * LET-352: stable preview-notice copy that every /api/sandbox response and
 * SSE payload echoes. The UI banner shows the same string so operators see a
 * single, consistent disclaimer regardless of which surface they read first.
 */
export const SANDBOX_PREVIEW_NOTICE =
  "Preview — no real container isolation yet. See ADR LET-328 for the buy-vs-build decision.";

/**
 * LET-352: pointer to the buy-vs-build ADR (LET-328). The `href` resolves to
 * the issue thread that hosts the rev-controlled ADR document so callers can
 * deep-link to it without baking a path-on-disk into clients.
 */
export const SANDBOX_PREVIEW_ADR = Object.freeze({
  id: "LET-328",
  href: "/issues/LET-328",
  summary:
    "Sandbox runtime buy-vs-build ADR — drives the preview/stub state of every /api/sandbox surface.",
});

function knownSandboxProviderKeys(): string[] {
  return listSandboxProviders().map((provider) => provider.provider);
}

function providerStatusMap(): Map<string, boolean> {
  return getSandboxProviderStatusMap();
}

function providerPreviewOnlyMap(): Map<string, boolean> {
  return getSandboxProviderPreviewOnlyMap();
}

function parseStatusFilter(req: Request): EnvironmentLeaseStatus | undefined {
  const raw = req.query.status;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw badRequest("Invalid 'status' query parameter", {
      code: SANDBOX_ERROR_CODES.INVALID_QUERY,
      field: "status",
    });
  }
  if (!(ENVIRONMENT_LEASE_STATUSES as readonly string[]).includes(raw)) {
    throw badRequest(`Unknown lease status: ${raw}`, {
      code: SANDBOX_ERROR_CODES.INVALID_QUERY,
      field: "status",
      allowed: ENVIRONMENT_LEASE_STATUSES,
    });
  }
  return raw as EnvironmentLeaseStatus;
}

function parseStringFilter(req: Request, field: string): string | undefined {
  const raw = req.query[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) {
    throw badRequest(`Invalid '${field}' query parameter`, {
      code: SANDBOX_ERROR_CODES.INVALID_QUERY,
      field,
    });
  }
  return raw;
}

function parseLimit(req: Request): number | undefined {
  const raw = req.query.limit;
  if (raw === undefined) return undefined;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badRequest("Invalid 'limit' query parameter", {
      code: SANDBOX_ERROR_CODES.INVALID_QUERY,
      field: "limit",
    });
  }
  return parsed;
}

function listProviderDescriptors(): SandboxProviderStatusSnapshot[] {
  return listSandboxProviderDescriptors();
}

export interface SandboxSnapshotMeta {
  previewOnly: true;
  generatedAt: string;
  /** LET-352: human-readable preview notice; mirrors the UI banner copy. */
  notice: typeof SANDBOX_PREVIEW_NOTICE;
  /** LET-352: pointer to the buy-vs-build ADR (LET-328). */
  adr: typeof SANDBOX_PREVIEW_ADR;
}

interface SandboxLeaseListResponse extends SandboxSnapshotMeta {
  count: number;
  leases: SandboxLeaseReadModel[];
}

interface SandboxLeaseGetResponse extends SandboxSnapshotMeta {
  lease: SandboxLeaseReadModel;
}

function snapshotMeta(): SandboxSnapshotMeta {
  return {
    previewOnly: true,
    generatedAt: new Date().toISOString(),
    notice: SANDBOX_PREVIEW_NOTICE,
    adr: SANDBOX_PREVIEW_ADR,
  };
}

function writeSseEvent(res: Response, event: { type: string; data: unknown; id?: number }): boolean {
  if (!res.writable) return false;
  try {
    // Each res.write returns false when the socket buffer is full. We treat
    // any false return as a backpressure signal so callers can cleanup the
    // subscription instead of indefinitely buffering for a slow consumer.
    let ok = true;
    if (event.id !== undefined && !res.write(`id: ${event.id}\n`)) ok = false;
    if (!res.write(`event: ${event.type}\n`)) ok = false;
    if (!res.write(`data: ${JSON.stringify(event.data)}\n\n`)) ok = false;
    return ok;
  } catch (err) {
    logger.warn({ err }, "sandbox sse write failed");
    return false;
  }
}

export function sandboxRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/sandbox/providers", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({
      ...snapshotMeta(),
      providers: listProviderDescriptors(),
    });
  });

  router.get("/companies/:companyId/sandbox/leases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const status = parseStatusFilter(req);
    const environmentId = parseStringFilter(req, "environmentId");
    const providerFilter = parseStringFilter(req, "provider");
    if (providerFilter && !isBuiltinSandboxProvider(providerFilter)) {
      throw notFound("Sandbox provider not registered", {
        code: SANDBOX_ERROR_CODES.PROVIDER_UNSUPPORTED,
        provider: providerFilter,
      });
    }
    const limit = parseLimit(req);

    const leases = await listSandboxLeasesForCompany(
      db,
      companyId,
      { status, environmentId, provider: providerFilter },
      { knownProviderKeys: knownSandboxProviderKeys(), limit },
    );
    const statuses = providerStatusMap();
    const previewOnly = providerPreviewOnlyMap();
    const readModels = leases.map((lease) => toSandboxLeaseReadModel(lease, statuses, previewOnly));
    const response: SandboxLeaseListResponse = {
      ...snapshotMeta(),
      count: readModels.length,
      leases: readModels,
    };
    res.json(response);
  });

  router.get("/companies/:companyId/sandbox/leases/:leaseId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const leaseId = req.params.leaseId as string;
    assertCompanyAccess(req, companyId);

    const lease = await getSandboxLeaseForCompany(db, companyId, leaseId);
    if (!lease) {
      throw notFound("Sandbox lease not found", {
        code: SANDBOX_ERROR_CODES.LEASE_NOT_FOUND,
        leaseId,
      });
    }
    const response: SandboxLeaseGetResponse = {
      ...snapshotMeta(),
      lease: toSandboxLeaseReadModel(lease, providerStatusMap(), providerPreviewOnlyMap()),
    };
    res.json(response);
  });

  /**
   * Preview-only validation. This endpoint accepts a sandbox provider
   * config, runs `validateConfig()` against the in-memory built-in
   * provider, and returns the redacted validation result. It explicitly
   * does NOT acquire a lease, contact Docker, or invoke any host action.
   * The response is always tagged `previewOnly: true`.
   */
  router.post("/companies/:companyId/sandbox/preview/validate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider : null;
    if (!provider) {
      throw badRequest("'provider' is required", {
        code: SANDBOX_ERROR_CODES.INVALID_QUERY,
        field: "provider",
      });
    }
    if (!isBuiltinSandboxProvider(provider)) {
      throw notFound("Sandbox provider not registered", {
        code: SANDBOX_ERROR_CODES.PROVIDER_UNSUPPORTED,
        provider,
      });
    }
    const config = body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : null;
    if (!config) {
      throw badRequest("'config' must be an object", {
        code: SANDBOX_ERROR_CODES.INVALID_QUERY,
        field: "config",
      });
    }
    const candidate = { ...config, provider } as Parameters<typeof validateSandboxProviderConfig>[0];

    let validation: Awaited<ReturnType<typeof validateSandboxProviderConfig>>;
    try {
      validation = await validateSandboxProviderConfig(candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw unprocessable("Sandbox config rejected", {
        code: SANDBOX_ERROR_CODES.POLICY_REJECTED,
        provider,
        reason: message,
      });
    }
    if (!validation.ok) {
      throw unprocessable("Sandbox config rejected", {
        code: SANDBOX_ERROR_CODES.POLICY_REJECTED,
        provider,
        summary: validation.summary,
        providerDetails: redactSandboxEventPayload(validation.details ?? null),
      });
    }

    // Built-in providers remain preview-only in this child even if a
    // runtime flag is set; report enablement separately so callers cannot
    // mistake validation for an attempt to start a real runtime.
    const status = providerStatusMap();
    res.json({
      ...snapshotMeta(),
      provider,
      enabled: status.get(provider) ?? false,
      validation: {
        ok: validation.ok,
        summary: validation.summary,
        details: redactSandboxEventPayload(validation.details ?? null),
      },
    });
  });

  /**
   * Preview-only egress policy evaluator. Accepts a proposed egress
   * intent (method/url/headers) and an optional sandbox network policy,
   * returns the deny-by-default decision + reason code + classification.
   *
   * This endpoint NEVER opens a socket, performs DNS, or invokes a real
   * proxy. The decision is computed from policy alone — `previewOnly` is
   * always `true` and `truth` is always `preview`. The redacted audit
   * record is also published on the sandbox event bus so subscribers can
   * mirror evaluator activity into the Command Center.
   */
  router.post("/companies/:companyId/sandbox/preview/egress", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawIntent = body.intent;
    if (!rawIntent || typeof rawIntent !== "object" || Array.isArray(rawIntent)) {
      throw badRequest("'intent' must be an object", {
        code: SANDBOX_ERROR_CODES.EGRESS_INTENT_INVALID,
        field: "intent",
      });
    }
    const intent = rawIntent as Record<string, unknown>;
    if (typeof intent.url !== "string" || intent.url.length === 0) {
      throw badRequest("'intent.url' is required", {
        code: SANDBOX_ERROR_CODES.EGRESS_INTENT_INVALID,
        field: "intent.url",
      });
    }
    if (typeof intent.method !== "string" || intent.method.length === 0) {
      throw badRequest("'intent.method' is required", {
        code: SANDBOX_ERROR_CODES.EGRESS_INTENT_INVALID,
        field: "intent.method",
      });
    }
    let headers: Record<string, string> | undefined;
    if (intent.headers !== undefined) {
      if (
        !intent.headers ||
        typeof intent.headers !== "object" ||
        Array.isArray(intent.headers)
      ) {
        throw badRequest("'intent.headers' must be an object", {
          code: SANDBOX_ERROR_CODES.EGRESS_INTENT_INVALID,
          field: "intent.headers",
        });
      }
      // We intentionally accept any string-valued header here. Values are
      // never echoed back; the redaction pipeline drops them entirely.
      headers = {};
      for (const [key, value] of Object.entries(intent.headers as Record<string, unknown>)) {
        if (typeof value === "string") headers[key] = value;
      }
    }
    let targetKind: EgressIntent["targetKind"] | undefined;
    if (intent.targetKind !== undefined) {
      if (intent.targetKind !== "http" && intent.targetKind !== "dns" && intent.targetKind !== "tcp") {
        throw badRequest("'intent.targetKind' must be one of http|dns|tcp", {
          code: SANDBOX_ERROR_CODES.EGRESS_INTENT_INVALID,
          field: "intent.targetKind",
        });
      }
      targetKind = intent.targetKind;
    }

    let policy: SandboxNetworkPolicy = DEFAULT_SANDBOX_NETWORK_POLICY;
    if (body.policy !== undefined) {
      try {
        policy = parseSandboxNetworkPolicy(body.policy);
      } catch (err) {
        if (err instanceof InvalidSandboxNetworkPolicyError) {
          throw badRequest(`Invalid sandbox network policy: ${err.message}`, {
            code: SANDBOX_ERROR_CODES.EGRESS_POLICY_INVALID,
            field: err.field,
            reason: err.reason,
          });
        }
        throw err;
      }
    }

    const intentInput: EgressIntent = {
      method: intent.method,
      url: intent.url,
      headers,
      targetKind,
    };

    let decision: EgressDecision;
    try {
      decision = evaluateEgressIntent(intentInput, policy);
    } catch (err) {
      // The pure evaluator throws InvalidEgressIntentError when the
      // method/url fail structural validation (e.g. method has spaces).
      // Surface as a typed 400 instead of leaking a 500.
      if (err instanceof InvalidEgressIntentError) {
        throw badRequest(`Invalid egress intent ${err.field}: ${err.reason}`, {
          code: SANDBOX_ERROR_CODES.EGRESS_INTENT_INVALID,
          field: `intent.${err.field}`,
          reason: err.reason,
        });
      }
      throw err;
    }
    const audit = summarizeEgressAudit({ intent: intentInput, decision });
    const redactedIntent: RedactedEgressIntent = audit.redactedIntent;

    // Publish a redacted preview event so subscribers can mirror evaluator
    // activity (preview-only — never accompanied by real traffic).
    publishSandboxEvent({
      companyId,
      type: "sandbox.egress.preview_evaluated",
      payload: {
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        classification: decision.classification,
        protocol: decision.protocol,
        policyMode: decision.policyMode,
        matchedAllowlistEntry: decision.matchedAllowlistEntry,
        previewOnly: true,
        truth: decision.truth,
        redactedIntent,
        message: audit.message,
      },
    });

    res.json({
      ...snapshotMeta(),
      decision,
      redactedIntent,
      audit: { message: audit.message },
    });
  });

  /**
   * Defensive guard: any HTTP verb that could be construed as a real
   * mutation must be rejected with PREVIEW_ONLY rather than 404, so
   * callers see a typed refusal instead of guessing whether the endpoint
   * exists.
   */
  router.all("/companies/:companyId/sandbox/leases/:leaseId/start", (req, _res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    throw conflict("Sandbox start is not exposed by the REST preview surface", {
      code: SANDBOX_ERROR_CODES.PREVIEW_ONLY,
    });
  });
  router.all("/companies/:companyId/sandbox/leases/:leaseId/stop", (req, _res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    throw conflict("Sandbox stop is not exposed by the REST preview surface", {
      code: SANDBOX_ERROR_CODES.PREVIEW_ONLY,
    });
  });

  /**
   * The egress proxy itself is not exposed by the preview surface. Any
   * caller that tries to "start" or "stop" a real proxy receives a typed
   * PREVIEW_ONLY refusal rather than a 404. Use POST /sandbox/preview/egress
   * to evaluate the policy without sending traffic.
   */
  router.all("/companies/:companyId/sandbox/egress/proxy/:action", (req, _res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    throw conflict("Sandbox egress proxy is not exposed by the REST preview surface", {
      code: SANDBOX_ERROR_CODES.PREVIEW_ONLY,
    });
  });

  /**
   * SSE: company-scoped sandbox event stream. Producers (the docker
   * provider scaffold, the reaper, future runtime workers) publish via
   * `publishSandboxEvent`; this endpoint replays the live stream.
   *
   * Cleanup: unsubscribe on connection close, on socket error, and on
   * res.writable becoming false (back-pressure). A keep-alive comment is
   * sent every 25 s to keep intermediaries from closing the connection.
   *
   * NOTE on backpressure: this endpoint is intentionally fire-and-forget.
   * If a slow consumer cannot keep up with `res.write`, the write returns
   * `false` and we unsubscribe to stop accumulating; the client must
   * reconnect to resume. This matches the existing plugin SSE pattern.
   */
  router.get("/companies/:companyId/sandbox/events", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    // Initial comment establishes the connection and prevents some
    // proxies from buffering until the first data frame.
    res.write(":ok\n\n");

    // Emit a `ready` event with the current provider snapshot so clients
    // have an authoritative starting point without an extra REST call.
    // LET-352: the ready payload carries the same preview notice + ADR
    // pointer as REST responses so SSE-only consumers cannot drift away
    // from the truth contract.
    writeSseEvent(res, {
      type: "sandbox.ready",
      data: {
        ...snapshotMeta(),
        providers: listProviderDescriptors(),
      },
    });

    let unsubscribed = false;
    const cleanup = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      unsubscribe();
      clearInterval(keepalive);
    };

    const unsubscribe = subscribeCompanySandboxEvents(companyId, (event: SandboxEvent) => {
      if (unsubscribed) return;
      // LET-352: every per-event payload echoes the preview notice + ADR
      // pointer alongside the canonical `previewOnly: true` invariant so
      // an SSE-only consumer never has to cross-reference REST to know
      // this stream describes a stub surface.
      const ok = writeSseEvent(res, {
        type: event.type,
        id: event.id,
        data: {
          id: event.id,
          companyId: event.companyId,
          type: event.type,
          createdAt: event.createdAt,
          payload: redactSandboxEventPayload(event.payload),
          previewOnly: true,
          notice: SANDBOX_PREVIEW_NOTICE,
          adr: SANDBOX_PREVIEW_ADR,
        },
      });
      if (!ok) cleanup();
    });

    const keepalive = setInterval(() => {
      if (!res.writable) {
        cleanup();
        return;
      }
      try {
        // A false return from keepalive write also signals backpressure;
        // unsubscribe rather than letting the kernel buffer grow.
        const ok = res.write(`:keepalive ${Date.now()}\n\n`);
        if (!ok) cleanup();
      } catch {
        cleanup();
      }
    }, SSE_KEEPALIVE_MS);
    keepalive.unref?.();

    req.on("close", cleanup);
    res.on("error", (err) => {
      logger.warn({ err, companyId }, "sandbox sse stream errored");
      cleanup();
    });
  });

  return router;
}

export const __testing = {
  writeSseEvent,
};

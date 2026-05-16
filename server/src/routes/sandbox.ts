/**
 * Phase 4A-2 (LET-314): /api/sandbox REST + SSE read-models.
 *
 * Preview-only. This surface exposes truthful lease / provider / artifact
 * status for future Command Center consumers without invoking any real
 * Docker run/build/pull/start/stop. The only mutation-like endpoint is
 * `POST /sandbox/preview/validate`, which is explicitly tagged
 * preview-only and runs the in-memory provider scaffold's `validateConfig`.
 */

import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  isBuiltinSandboxProvider,
  listSandboxProviders,
  validateSandboxProviderConfig,
} from "../services/sandbox-provider-runtime.js";
import {
  DOCKER_SANDBOX_PROVIDER_KEY,
  __testing as dockerProviderTesting,
} from "../services/sandbox/docker-provider.js";
import {
  getSandboxLeaseForCompany,
  listSandboxLeasesForCompany,
} from "../services/sandbox/queries.js";
import {
  describeBuiltinSandboxProvider,
  redactSandboxEventPayload,
  toSandboxLeaseReadModel,
  type SandboxLeaseReadModel,
  type SandboxProviderDescriptor,
} from "../services/sandbox/read-model.js";
import {
  subscribeCompanySandboxEvents,
  type SandboxEvent,
} from "../services/sandbox/events.js";
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
} as const;

const SSE_KEEPALIVE_MS = 25_000;

function knownSandboxProviderKeys(): string[] {
  return listSandboxProviders().map((provider) => provider.provider);
}

function providerStatusMap(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const provider of listSandboxProviders()) {
    if (provider.provider === DOCKER_SANDBOX_PROVIDER_KEY) {
      out.set(provider.provider, dockerProviderTesting.isDockerSandboxEnabled());
    } else {
      out.set(provider.provider, false);
    }
  }
  return out;
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

function listProviderDescriptors(): SandboxProviderDescriptor[] {
  const status = providerStatusMap();
  return listSandboxProviders()
    .map((provider) =>
      describeBuiltinSandboxProvider({
        provider: provider.provider,
        enabled: status.get(provider.provider) ?? false,
      }),
    )
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

interface SandboxLeaseListResponse {
  previewOnly: true;
  generatedAt: string;
  count: number;
  leases: SandboxLeaseReadModel[];
}

interface SandboxLeaseGetResponse {
  previewOnly: true;
  generatedAt: string;
  lease: SandboxLeaseReadModel;
}

function snapshotMeta(): { previewOnly: true; generatedAt: string } {
  return { previewOnly: true, generatedAt: new Date().toISOString() };
}

function writeSseEvent(res: Response, event: { type: string; data: unknown; id?: number }): boolean {
  if (!res.writable) return false;
  try {
    if (event.id !== undefined) res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    return true;
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
    const readModels = leases.map((lease) => toSandboxLeaseReadModel(lease, statuses));
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
      lease: toSandboxLeaseReadModel(lease, providerStatusMap()),
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

    // The Docker provider is preview-only in this child even if its
    // runtime flag is set; report this explicitly so callers cannot
    // mistake validation for an attempt to start a real container.
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
   * Defensive guard: any HTTP verb that could be construed as a real
   * mutation must be rejected with PREVIEW_ONLY rather than 404, so
   * callers see a typed refusal instead of guessing whether the endpoint
   * exists.
   */
  router.all("/companies/:companyId/sandbox/leases/:leaseId/start", (_req, _res) => {
    throw conflict("Sandbox start is not exposed by the REST preview surface", {
      code: SANDBOX_ERROR_CODES.PREVIEW_ONLY,
    });
  });
  router.all("/companies/:companyId/sandbox/leases/:leaseId/stop", (_req, _res) => {
    throw conflict("Sandbox stop is not exposed by the REST preview surface", {
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
    writeSseEvent(res, {
      type: "sandbox.ready",
      data: {
        previewOnly: true,
        generatedAt: new Date().toISOString(),
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
        res.write(`:keepalive ${Date.now()}\n\n`);
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

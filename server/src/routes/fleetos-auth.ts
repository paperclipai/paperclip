import { Router } from "express";
import { logger } from "../middleware/logger.js";

/**
 * Error thrown when the FleetOS upstream is unreachable or returns a server error.
 * Distinguishes infrastructure failures from authentication rejections.
 */
export class FleetosUpstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
  ) {
    super(message);
    this.name = "FleetosUpstreamError";
  }
}

/**
 * Validate a FleetOS API key by calling the FleetOS backend.
 *
 * @returns An object with `tenantId`, `tenantName`, and `companyId` when the key is valid; `null` if the key is rejected (HTTP 401/403) or the response is not OK for other client-level reasons.
 * @throws FleetosUpstreamError when FleetOS is unreachable (network error) or returns a server error (HTTP 5xx). The error's `statusCode` is the HTTP status for server errors or `null` for network-level failures.
 */
async function validateFleetosApiKey(
  fleetosApiUrl: string,
  apiKey: string,
): Promise<{ tenantId: string; tenantName: string; companyId: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${fleetosApiUrl}/api/tenants`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout, etc.)
    throw new FleetosUpstreamError(
      `FleetOS API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  }

  // 401/403 = the key is invalid or revoked — return null (auth rejected)
  if (res.status === 401 || res.status === 403) return null;

  // 5xx = FleetOS server error — bubble up as upstream failure
  if (res.status >= 500) {
    throw new FleetosUpstreamError(
      `FleetOS returned server error ${res.status}`,
      res.status,
    );
  }

  // Other non-OK (e.g. 404, 400) — treat as auth invalid
  if (!res.ok) return null;

  // FleetOS GET /api/tenants returns an array of tenants visible to the key.
  // For tenant-scoped keys this is a single-element list; for admin keys it's all tenants.
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new FleetosUpstreamError(
      `FleetOS returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      res.status,
    );
  }

  // Normalize: response is either an array of tenants or a single tenant object
  const tenants = (Array.isArray(raw) ? raw : [raw]).filter(
    (t): t is Record<string, unknown> => t !== null && typeof t === "object",
  );
  if (tenants.length === 0) return null;

  // Use the first tenant as the identity (tenant-scoped keys return exactly one)
  const first = tenants[0] as {
    id?: string;
    tenant_id?: string;
    name?: string;
    tenant_name?: string;
    company_id?: string;
    role?: string;
  };
  const tenantId = first.tenant_id ?? first.id;
  const tenantName = first.tenant_name ?? first.name ?? "FleetOS Tenant";
  if (!tenantId) return null;

  // For admin keys (multiple tenants), use "platform" as the companyId
  const isAdmin = first.role === "admin" || tenants.length > 1;
  const companyId = first.company_id ?? (isAdmin ? "platform" : tenantId);
  return { tenantId: isAdmin ? "platform" : tenantId, tenantName: isAdmin ? "Raava Platform" : tenantName, companyId };
}

export interface FleetosAuthRoutesOptions {
  fleetosApiUrl: string;
}

/**
 * Create Express routes for FleetOS API-key authentication.
 *
 * Provides three endpoints mounted under the router:
 * - POST /login: accepts `{ apiKey }`, validates it against FleetOS, and sets an HTTP-only `fleetos_session` cookie on success; responds with tenant info.
 * - POST /logout: clears the `fleetos_session` cookie and returns `{ ok: true }`.
 * - GET /me: returns tenant and user identifiers when the request is authenticated via a FleetOS API-key session; otherwise responds with 401.
 *
 * @param opts - Configuration options containing `fleetosApiUrl` used to validate API keys
 * @returns An Express `Router` configured with the FleetOS authentication routes
 */
export function fleetosAuthRoutes(opts: FleetosAuthRoutesOptions) {
  const router = Router();

  /**
   * POST /api/fleetos/login
   * Accepts { apiKey: string }, validates against FleetOS, creates a session cookie.
   */
  router.post("/login", async (req, res) => {
    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string") {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    let tenant: Awaited<ReturnType<typeof validateFleetosApiKey>>;
    try {
      tenant = await validateFleetosApiKey(opts.fleetosApiUrl, apiKey);
    } catch (err) {
      if (err instanceof FleetosUpstreamError) {
        logger.error({ err }, "FleetOS upstream failure during login");
        res.status(502).json({ error: "FleetOS service unavailable", detail: err.message });
        return;
      }
      throw err;
    }
    if (!tenant) {
      res.status(401).json({ error: "Invalid FleetOS API key" });
      return;
    }

    // Store the API key and tenant info in an httpOnly session cookie.
    // We use a signed cookie with JSON payload so the middleware can read it back.
    const sessionPayload = JSON.stringify({
      apiKey,
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      companyId: tenant.companyId,
    });
    const encoded = Buffer.from(sessionPayload).toString("base64");

    res.cookie("fleetos_session", encoded, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: "/",
    });

    res.json({
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      companyId: tenant.companyId,
    });
  });

  /**
   * POST /api/fleetos/logout
   * Clears the FleetOS session cookie.
   */
  router.post("/logout", (_req, res) => {
    res.clearCookie("fleetos_session", { path: "/" });
    res.json({ ok: true });
  });

  /**
   * GET /api/fleetos/me
   * Returns current tenant info from the FleetOS session cookie.
   */
  router.get("/me", (req, res) => {
    if (
      req.actor.type === "board" &&
      req.actor.source === "fleetos_api_key" &&
      req.actor.fleetosTenantId
    ) {
      res.json({
        tenantId: req.actor.fleetosTenantId,
        companyId: req.actor.companyId,
        userId: req.actor.userId,
      });
      return;
    }
    res.status(401).json({ error: "No active FleetOS session" });
  });

  return router;
}

export { validateFleetosApiKey };

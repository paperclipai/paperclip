import type { RequestHandler } from "express";
import { logger } from "./logger.js";

const API_TIMEOUT_MS = 10_000;
const SLOW_REQUEST_MS = 2_000;
const BACKPRESSURE_LIMIT = 3;
const BACKPRESSURE_RETRY_AFTER_SECONDS = 5;
const POLLING_RATE_LIMIT_PER_MINUTE = 30;
const POLLING_RATE_LIMIT_WINDOW_MS = 60_000;
const LIVE_RUNS_COALESCE_WINDOW_MS = 1_000;
const POLLING_CACHE_CONTROL_HEADER = "private, max-age=1, must-revalidate";

type RouteFamily = "live_runs" | "dashboard" | "agent_runs" | "issue_live_runs" | "heartbeat_logs" | "issues";

const STREAMING_PATH_RE = /^(?:\/api)?\/plugins\/[^/]+\/events(?:\/|$)/;
const LIVE_RUNS_PATH_RE = /^(?:\/api)?\/companies\/([^/]+)\/live-runs(?:\/|$)/;
const DASHBOARD_PATH_RE = /^(?:\/api)?\/companies\/([^/]+)\/dashboard(?:\/|$)/;
const AGENT_RUNS_PATH_RE = /^(?:\/api)?\/companies\/([^/]+)\/heartbeat-runs(?:\/|$)/;
const ISSUE_LIVE_RUNS_PATH_RE = /^(?:\/api)?\/issues\/[^/]+\/live-runs(?:\/|$)/;
const HEARTBEAT_LOGS_PATH_RE = /^(?:\/api)?\/heartbeat-runs\/[^/]+\/log(?:\/|$)/;
const ISSUES_PATH_RE = /^(?:\/api)?\/issues(?:\/|$)/;

export function createApiRouteTimeoutMiddleware(opts?: {
  timeoutMs?: number;
  slowRequestMs?: number;
}): RequestHandler {
  const timeoutMs = opts?.timeoutMs ?? API_TIMEOUT_MS;
  const slowRequestMs = opts?.slowRequestMs ?? SLOW_REQUEST_MS;

  return (req, res, next) => {
    const startedAt = Date.now();
    const pathname = normalizePath(req.originalUrl ?? req.url);
    const isStreaming = isStreamingRequest(pathname, req.header("accept"));

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (!isStreaming) {
      timeoutHandle = setTimeout(() => {
        if (res.headersSent) return;
        res.status(503).json({ error: "service_unavailable", reason: "timeout" });
      }, timeoutMs);
    }

    const finalize = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      const durationMs = Date.now() - startedAt;
      if (durationMs > slowRequestMs) {
        logger.warn(
          { method: req.method, path: pathname, durationMs, statusCode: res.statusCode },
          "slow api route",
        );
      }
    };

    res.on("finish", finalize);
    res.on("close", finalize);
    next();
  };
}

export function createPollingBackpressureMiddleware(opts?: {
  maxInflight?: number;
  retryAfterSeconds?: number;
}): RequestHandler {
  const maxInflight = opts?.maxInflight ?? BACKPRESSURE_LIMIT;
  const retryAfterSeconds = opts?.retryAfterSeconds ?? BACKPRESSURE_RETRY_AFTER_SECONDS;
  const inflightByKey = new Map<string, number>();

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const pathname = normalizePath(req.originalUrl ?? req.url);
    const familyMatch = resolveFamilyAndCompany(pathname, req);
    if (!familyMatch) {
      next();
      return;
    }

    const key = `${familyMatch.family}:${familyMatch.companyId}`;
    const inflight = inflightByKey.get(key) ?? 0;
    if (inflight >= maxInflight) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: "too_many_requests", reason: "backpressure" });
      return;
    }

    inflightByKey.set(key, inflight + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const current = inflightByKey.get(key) ?? 0;
      if (current <= 1) {
        inflightByKey.delete(key);
        return;
      }
      inflightByKey.set(key, current - 1);
    };

    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

export function createPollingRateLimitAndCoalescingMiddleware(opts?: {
  requestsPerMinute?: number;
  windowMs?: number;
  liveRunsCoalesceWindowMs?: number;
  cacheControlHeader?: string;
}): RequestHandler {
  const requestsPerMinute = Math.max(1, opts?.requestsPerMinute ?? POLLING_RATE_LIMIT_PER_MINUTE);
  const windowMs = Math.max(1_000, opts?.windowMs ?? POLLING_RATE_LIMIT_WINDOW_MS);
  const liveRunsCoalesceWindowMs = Math.max(100, opts?.liveRunsCoalesceWindowMs ?? LIVE_RUNS_COALESCE_WINDOW_MS);
  const cacheControlHeader = opts?.cacheControlHeader ?? POLLING_CACHE_CONTROL_HEADER;

  const requestWindowState = new Map<string, { windowStartMs: number; count: number }>();
  const liveRunsResponseCache = new Map<string, { expiresAtMs: number; payload: unknown }>();

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const pathname = normalizePath(req.originalUrl ?? req.url);
    const familyMatch = resolveFamilyAndCompany(pathname, req);
    if (!familyMatch) {
      next();
      return;
    }

    res.setHeader("Cache-Control", cacheControlHeader);

    const clientId = resolveClientId(req);
    const rateKey = `${familyMatch.family}:${familyMatch.companyId}:${clientId}`;
    const now = Date.now();
    const previous = requestWindowState.get(rateKey);
    if (!previous || now - previous.windowStartMs >= windowMs) {
      requestWindowState.set(rateKey, { windowStartMs: now, count: 1 });
    } else {
      previous.count += 1;
      if (previous.count > requestsPerMinute) {
        const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - previous.windowStartMs)) / 1_000));
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json({ error: "too_many_requests", reason: "rate_limit" });
        return;
      }
    }

    if (familyMatch.family !== "live_runs" && familyMatch.family !== "issue_live_runs") {
      next();
      return;
    }

    const cacheKey = `${familyMatch.family}:${familyMatch.companyId}:${clientId}:${pathname}`;
    const cached = liveRunsResponseCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      res.json(cached.payload);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (payload: unknown) => {
      liveRunsResponseCache.set(cacheKey, {
        payload,
        expiresAtMs: Date.now() + liveRunsCoalesceWindowMs,
      });
      return originalJson(payload);
    };

    next();
  };
}

function normalizePath(path: string | undefined): string {
  if (!path) return "/";
  const raw = path.trim();
  if (!raw) return "/";
  const pathname = raw.split("?")[0]?.trim() ?? "/";
  return pathname || "/";
}

function isStreamingRequest(pathname: string, acceptHeader: string | undefined) {
  if (STREAMING_PATH_RE.test(pathname)) return true;
  return Boolean(acceptHeader && acceptHeader.toLowerCase().includes("text/event-stream"));
}

function resolveActorCompanyId(req: {
  actor?: {
    type?: "board" | "agent" | "none";
    companyId?: string;
    companyIds?: string[];
  };
}) {
  if (req.actor?.type === "agent" && req.actor.companyId) return req.actor.companyId;
  if (req.actor?.type === "board" && Array.isArray(req.actor.companyIds) && req.actor.companyIds.length === 1) {
    return req.actor.companyIds[0]!;
  }
  return null;
}

function resolveClientId(req: {
  actor?: {
    type?: "board" | "agent" | "none";
    agentId?: string;
  };
  ip?: string;
  header(name: string): string | undefined;
}): string {
  if (req.actor?.type === "agent" && req.actor.agentId) return `agent:${req.actor.agentId}`;
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  const realIp = req.header("x-real-ip");
  if (realIp) return `ip:${realIp}`;
  return `ip:${req.ip ?? "unknown"}`;
}

function resolveFamilyAndCompany(
  pathname: string,
  req: {
    actor?: {
      type?: "board" | "agent" | "none";
      companyId?: string;
      companyIds?: string[];
    };
  },
): { family: RouteFamily; companyId: string } | null {
  const liveRunsMatch = pathname.match(LIVE_RUNS_PATH_RE);
  if (liveRunsMatch?.[1]) return { family: "live_runs", companyId: liveRunsMatch[1] };

  const dashboardMatch = pathname.match(DASHBOARD_PATH_RE);
  if (dashboardMatch?.[1]) return { family: "dashboard", companyId: dashboardMatch[1] };

  const agentRunsMatch = pathname.match(AGENT_RUNS_PATH_RE);
  if (agentRunsMatch?.[1]) return { family: "agent_runs", companyId: agentRunsMatch[1] };

  if (ISSUE_LIVE_RUNS_PATH_RE.test(pathname)) {
    const companyId = resolveActorCompanyId(req);
    if (companyId) return { family: "issue_live_runs", companyId };
  }

  if (HEARTBEAT_LOGS_PATH_RE.test(pathname)) {
    const companyId = resolveActorCompanyId(req);
    if (companyId) return { family: "heartbeat_logs", companyId };
  }

  if (ISSUES_PATH_RE.test(pathname)) {
    const companyId = resolveActorCompanyId(req);
    if (companyId) return { family: "issues", companyId };
  }

  return null;
}

export const apiRouteTimeoutMiddleware: RequestHandler = createApiRouteTimeoutMiddleware();
export const pollingBackpressureMiddleware: RequestHandler = createPollingBackpressureMiddleware();
export const pollingRateLimitAndCoalescingMiddleware: RequestHandler = createPollingRateLimitAndCoalescingMiddleware();

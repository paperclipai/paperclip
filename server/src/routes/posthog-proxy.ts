// Same-origin reverse proxy for browser PostHog traffic on Paperclip Cloud.
//
// Ad blockers drop requests to PostHog's own hosts, so the board UI sends to
// `/_ph` on its own origin and this proxy forwards them.
//
// It is not a generic proxy. It forwards only the requests posthog-js makes:
// the method and path must match `POSTHOG_PROXY_ROUTES`, and the upstream is
// always the configured ingest host or its static assets host. Everything
// else answers 404 without contacting PostHog.
//
// `app.ts` mounts it only when browser analytics is on (see
// `services/cloud-posthog-browser.ts`), before any body parser, so request and
// response bodies stream through without buffering. It carries no Paperclip
// data and grants nothing: it builds a fresh header set from an allowlist, so
// the browser's Host, Cookie and Authorization headers never leave.

import http from "node:http";
import https from "node:https";
import { pipeline, Transform } from "node:stream";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { Router, type Request, type Response } from "express";
import { isPublicIpAddress } from "../lib/ip-address.js";
import { logger } from "../middleware/logger.js";
import type { CloudInstanceEnv } from "../services/cloud-instance.js";
import {
  POSTHOG_PROXY_PATH,
  posthogAssetsOrigin,
  resolveBrowserPostHogConfig,
} from "../services/cloud-posthog-browser.js";

const UPSTREAM_TIMEOUT_MS = 30_000;

export type PostHogProxyLimits = {
  /** Largest request body forwarded (PostHog's own proxy guide uses 64 MiB). */
  maxBodyBytes: number;
  /** Requests in flight from one client address. */
  maxInFlightPerClient: number;
  /** Requests in flight for the whole proxy. */
  maxInFlight: number;
  requestDeadlineMs: number;
};

export const DEFAULT_POSTHOG_PROXY_LIMITS: PostHogProxyLimits = {
  maxBodyBytes: 64 * 1024 * 1024,
  maxInFlightPerClient: 128,
  maxInFlight: 1024,
  requestDeadlineMs: 60_000,
};

export const POSTHOG_PROXY_MAX_IN_FLIGHT_ENV = "PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT";
export const POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT_ENV = "PAPERCLIP_POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT";

const LIMIT_WARNING_INTERVAL_MS = 60_000;
const MAX_CONFIGURED_IN_FLIGHT = 65_536;

type LimitWarning = (fields: Record<string, unknown>, message: string) => void;

function warnWithLogger(fields: Record<string, unknown>, message: string) {
  logger.warn(fields, message);
}

function parseInFlightLimit(
  env: CloudInstanceEnv,
  name: string,
  fallback: number,
  warn: LimitWarning,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim();
  const parsed = Number(value);
  if (/^[1-9][0-9]*$/.test(value) && parsed <= MAX_CONFIGURED_IN_FLIGHT) return parsed;
  warn(
    { variable: name, defaultValue: fallback, maxValue: MAX_CONFIGURED_IN_FLIGHT },
    `${name} is not an integer from 1 to ${MAX_CONFIGURED_IN_FLIGHT}; the PostHog proxy uses the default`,
  );
  return fallback;
}

export function resolvePostHogProxyLimits(
  env: CloudInstanceEnv = process.env,
  warn: LimitWarning = warnWithLogger,
): PostHogProxyLimits {
  return {
    maxBodyBytes: DEFAULT_POSTHOG_PROXY_LIMITS.maxBodyBytes,
    requestDeadlineMs: DEFAULT_POSTHOG_PROXY_LIMITS.requestDeadlineMs,
    maxInFlight: parseInFlightLimit(env, POSTHOG_PROXY_MAX_IN_FLIGHT_ENV, DEFAULT_POSTHOG_PROXY_LIMITS.maxInFlight, warn),
    maxInFlightPerClient: parseInFlightLimit(
      env,
      POSTHOG_PROXY_MAX_IN_FLIGHT_PER_CLIENT_ENV,
      DEFAULT_POSTHOG_PROXY_LIMITS.maxInFlightPerClient,
      warn,
    ),
  };
}

export function posthogProxyClientKey(ip: string | undefined): string | null {
  return ip && isPublicIpAddress(ip) ? ip : null;
}

export type PostHogProxyLimitReason = "total" | "per_client";

export function createPostHogProxyLimitReporter(
  limits: PostHogProxyLimits,
  options: { now?: () => number; warn?: LimitWarning; intervalMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const warn = options.warn ?? warnWithLogger;
  const intervalMs = options.intervalMs ?? LIMIT_WARNING_INTERVAL_MS;
  let lastWarnedAt: number | null = null;
  const refused: Record<PostHogProxyLimitReason, number> = { total: 0, per_client: 0 };

  return (reason: PostHogProxyLimitReason, inFlight: number) => {
    refused[reason] += 1;
    const at = now();
    if (lastWarnedAt !== null && at - lastWarnedAt < intervalMs) return;
    warn(
      {
        refusedAtTotalLimit: refused.total,
        refusedAtPerClientLimit: refused.per_client,
        inFlight,
        maxInFlight: limits.maxInFlight,
        maxInFlightPerClient: limits.maxInFlightPerClient,
        sinceMs: lastWarnedAt === null ? null : at - lastWarnedAt,
      },
      "PostHog proxy refused requests at its in-flight limit",
    );
    lastWarnedAt = at;
    refused.total = 0;
    refused.per_client = 0;
  };
}

const BODY_TOO_LARGE = "posthog_proxy_body_too_large";

type PostHogUpstream = "ingest" | "assets";

/**
 * Every request posthog-js makes with surveys, product tours, web experiments
 * and conversations turned off (see `ui/src/lib/analytics/product-analytics.ts`).
 */
const POSTHOG_PROXY_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; path: RegExp; upstream: PostHogUpstream }> = [
  // Event batches, including the newer `/i/v0/e/` endpoint.
  { method: "POST", path: /^\/(?:i\/v0\/)?e\/?$/, upstream: "ingest" },
  { method: "POST", path: /^\/batch\/?$/, upstream: "ingest" },
  // Session replay snapshots.
  { method: "POST", path: /^\/s\/?$/, upstream: "ingest" },
  // Remote settings (they carry the project's replay and autocapture switches).
  { method: "POST", path: /^\/(?:flags|decide)\/?$/, upstream: "ingest" },
  // Project config and lazily loaded extensions (recorder, web vitals, ...).
  { method: "GET", path: /^\/array\/[A-Za-z0-9_-]+\/config(?:\.js)?$/, upstream: "assets" },
  // posthog-js first asks for a versioned path (`/static/1.442.1/x.js`).
  { method: "GET", path: /^\/static\/(?:\d+\.\d+\.\d+\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/, upstream: "assets" },
];

/** Request headers PostHog needs. Host, cookies, auth and tracing headers never leave. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "content-encoding",
  "content-length",
  "content-type",
  "user-agent",
] as const;

/** Response headers that describe the connection or set state on our origin. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "strict-transport-security",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The upstream URL for an allowed request, or null. `requestUrl` is the path
 * and query below the proxy mount.
 */
export function posthogUpstreamUrl(ingestHost: string, method: string, requestUrl: string): URL | null {
  const queryAt = requestUrl.indexOf("?");
  const path = queryAt === -1 ? requestUrl : requestUrl.slice(0, queryAt);
  const query = queryAt === -1 ? "" : requestUrl.slice(queryAt);
  const route = POSTHOG_PROXY_ROUTES.find((candidate) => candidate.method === method && candidate.path.test(path));
  if (!route) return null;
  const origin = route.upstream === "assets" ? posthogAssetsOrigin(ingestHost) : new URL(ingestHost).origin;
  // The path matched a fixed pattern, so it cannot name another host.
  return new URL(`${origin}${path}${query}`);
}

export function posthogVisitorIp(peerIp: string | undefined, headers: IncomingHttpHeaders): string | undefined {
  if (peerIp && isPublicIpAddress(peerIp)) return peerIp;
  const raw = headers["x-forwarded-for"];
  const entries = (Array.isArray(raw) ? raw.join(",") : raw ?? "").split(",").map((entry) => entry.trim());
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (isPublicIpAddress(entry)) return entry;
  }
  return peerIp;
}

export function posthogForwardRequestHeaders(
  headers: IncomingHttpHeaders,
  clientIp: string | undefined,
  upstreamHost: string,
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = { host: upstreamHost };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = headers[name];
    if (value !== undefined) forwarded[name] = value;
  }
  // PostHog derives the visitor's location from this header behind a proxy.
  if (clientIp) forwarded["x-forwarded-for"] = clientIp;
  return forwarded;
}

export function posthogProxyRoutes(
  ingestHost: string,
  limits: PostHogProxyLimits = DEFAULT_POSTHOG_PROXY_LIMITS,
  reportLimit: (reason: PostHogProxyLimitReason, inFlight: number) => void = createPostHogProxyLimitReporter(limits),
) {
  const router = Router();
  let inFlight = 0;
  const inFlightByClient = new Map<string, number>();

  router.use((req: Request, res: Response) => {
    let upstream: URL | null;
    try {
      upstream = posthogUpstreamUrl(ingestHost, req.method, req.url);
    } catch {
      upstream = null;
    }
    if (!upstream) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const target = upstream;
    let received = 0;
    let bodyTooLarge = false;

    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > limits.maxBodyBytes) {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }

    // Bound the work one browser, or all of them, can put on this process.
    const client = posthogProxyClientKey(req.ip);
    const clientInFlight = client === null ? 0 : inFlightByClient.get(client) ?? 0;
    const refusedBy: PostHogProxyLimitReason | null =
      inFlight >= limits.maxInFlight
        ? "total"
        : client !== null && clientInFlight >= limits.maxInFlightPerClient
          ? "per_client"
          : null;
    if (refusedBy) {
      reportLimit(refusedBy, inFlight);
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    inFlight += 1;
    if (client !== null) inFlightByClient.set(client, clientInFlight + 1);
    res.once("close", () => {
      inFlight -= 1;
      if (client === null) return;
      const remaining = (inFlightByClient.get(client) ?? 1) - 1;
      if (remaining > 0) inFlightByClient.set(client, remaining);
      else inFlightByClient.delete(client);
    });

    const transport = target.protocol === "https:" ? https : http;
    const upstreamReq = transport.request(target, {
      method: req.method,
      headers: posthogForwardRequestHeaders(req.headers, posthogVisitorIp(req.ip, req.headers), target.host),
      timeout: UPSTREAM_TIMEOUT_MS,
    });

    upstreamReq.on("response", (upstreamRes) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      // pipeline() handles an error on either side (PostHog closing the
      // connection mid-response, the browser going away) by destroying both
      // streams, so no stream error goes unhandled.
      pipeline(upstreamRes, res, (err) => {
        if (err) logger.debug({ err, path: target.pathname }, "PostHog proxy response ended early");
      });
    });
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("posthog_proxy_timeout"));
    });
    const deadline = setTimeout(() => {
      if (res.headersSent || upstreamReq.destroyed) res.destroy();
      upstreamReq.destroy(new Error("posthog_proxy_deadline"));
    }, limits.requestDeadlineMs);
    res.once("close", () => clearTimeout(deadline));
    upstreamReq.on("error", (err) => {
      logger.debug({ err, path: target.pathname }, "PostHog proxy request failed");
      if (!res.headersSent && bodyTooLarge) {
        res.status(413).json({ error: "payload_too_large" });
      } else if (!res.headersSent) {
        res.status(502).json({ error: "analytics_upstream_unavailable" });
      } else {
        res.destroy();
      }
    });
    // The browser went away: stop the upstream request too.
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });

    // A body without (or with a false) Content-Length is counted as it
    // streams and cut off at the limit.
    const sizeLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limits.maxBodyBytes) {
          bodyTooLarge = true;
          callback(new Error(BODY_TOO_LARGE));
        } else {
          callback(null, chunk);
        }
      },
    });
    // An aborted or oversized browser upload destroys the upstream request,
    // whose error listener above answers or closes the browser response.
    pipeline(req, sizeLimit, upstreamReq, () => {});
  });

  return router;
}

/**
 * The proxy mount for this instance, or null when browser analytics is off.
 * Self-hosted installs always get null, so `/_ph` falls through to the UI.
 */
export function resolvePostHogProxyMount(env: CloudInstanceEnv = process.env) {
  const config = resolveBrowserPostHogConfig(env);
  if (!config) return null;
  try {
    posthogAssetsOrigin(config.host);
  } catch {
    logger.warn("PAPERCLIP_POSTHOG_HOST is not a valid URL; the PostHog proxy is off");
    return null;
  }
  const limits = resolvePostHogProxyLimits(env);
  return { path: POSTHOG_PROXY_PATH, router: posthogProxyRoutes(config.host, limits), limits };
}

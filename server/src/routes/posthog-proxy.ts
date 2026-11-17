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
};

export const DEFAULT_POSTHOG_PROXY_LIMITS: PostHogProxyLimits = {
  maxBodyBytes: 64 * 1024 * 1024,
  maxInFlightPerClient: 16,
  maxInFlight: 256,
};

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

export function posthogProxyRoutes(ingestHost: string, limits: PostHogProxyLimits = DEFAULT_POSTHOG_PROXY_LIMITS) {
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
    const client = req.ip ?? "unknown";
    const clientInFlight = inFlightByClient.get(client) ?? 0;
    if (inFlight >= limits.maxInFlight || clientInFlight >= limits.maxInFlightPerClient) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    inFlight += 1;
    inFlightByClient.set(client, clientInFlight + 1);
    res.once("close", () => {
      inFlight -= 1;
      const remaining = (inFlightByClient.get(client) ?? 1) - 1;
      if (remaining > 0) inFlightByClient.set(client, remaining);
      else inFlightByClient.delete(client);
    });

    const transport = target.protocol === "https:" ? https : http;
    const upstreamReq = transport.request(target, {
      method: req.method,
      headers: posthogForwardRequestHeaders(req.headers, req.ip, target.host),
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
  return { path: POSTHOG_PROXY_PATH, router: posthogProxyRoutes(config.host) };
}

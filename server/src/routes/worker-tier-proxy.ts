/**
 * @fileoverview Worker-tier reverse proxy for the API/worker HA split.
 *
 * When PAPERCLIP_NODE_ROLE=api the process runs the API-tier stub
 * pluginWorkerManager (see services/plugin-worker-manager-stub.ts), which
 * throws on startWorker/stopWorker/call. Plugin lifecycle and bridge routes
 * that reach those methods therefore 503 on the API tier — every
 * worker-backed plugin fails to activate.
 *
 * This module forwards that small, explicit set of worker-dependent plugin
 * routes to the worker tier's internal Service. The worker pod runs the
 * identical server binary with a real pluginWorkerManager, so it handles the
 * request end-to-end (DB writes + worker spawn + events) on the correct pod.
 *
 * The allowlist is deliberately tight (see WORKER_DEPENDENT_PLUGIN_ROUTES):
 * read routes work fine on the API tier against the shared DB and must NOT
 * be proxied. A future worker-dependent route has to be added here
 * explicitly.
 */

import { Readable } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";
import type { Request, RequestHandler, Router } from "express";
import { logger } from "../middleware/logger.js";

/**
 * Plugin routes whose handlers reach pluginWorkerManager.{startWorker,
 * stopWorker,call} and therefore cannot run on the API tier. Paths are
 * relative to the plugin router mount (the router is mounted under /api).
 */
export const WORKER_DEPENDENT_PLUGIN_ROUTES: ReadonlyArray<{
  method: "get" | "post" | "delete";
  path: string;
  /** Long-lived response (SSE) — skip the request timeout, stream the body. */
  streaming?: boolean;
}> = [
  // Static paths first so they are matched before parameterized ones.
  { method: "post", path: "/plugins/install" },
  { method: "post", path: "/plugins/tools/execute" },
  // Lifecycle — enable/disable/upgrade/uninstall all drive worker start/stop.
  { method: "post", path: "/plugins/:pluginId/enable" },
  { method: "post", path: "/plugins/:pluginId/disable" },
  { method: "post", path: "/plugins/:pluginId/upgrade" },
  { method: "delete", path: "/plugins/:pluginId" },
  // Config save triggers restartWorker; config/test issues a validateConfig RPC.
  { method: "post", path: "/plugins/:pluginId/config" },
  { method: "post", path: "/plugins/:pluginId/config/test" },
  // Manual job trigger dispatches into the worker.
  { method: "post", path: "/plugins/:pluginId/jobs/:jobId/trigger" },
  // UI bridge — getData/performAction RPCs and the SSE push channel.
  { method: "post", path: "/plugins/:pluginId/bridge/data" },
  { method: "post", path: "/plugins/:pluginId/bridge/action" },
  { method: "post", path: "/plugins/:pluginId/data/:key" },
  { method: "post", path: "/plugins/:pluginId/actions/:key" },
  { method: "get", path: "/plugins/:pluginId/bridge/stream/:channel", streaming: true },
];

/** Non-streaming proxied requests abort after this long. */
const PROXY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Hop-by-hop headers (RFC 7230 §6.1) plus headers that must be recomputed by
 * the fetch layer. Never forwarded in either direction.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // Drop accept-encoding so the worker replies identity-encoded — we stream
  // the body straight through and never re-encode.
  "accept-encoding",
]);

function forwardRequestHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    out.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  // The `host` header is stripped above so fetch addresses the worker
  // Service correctly. But the worker tier runs the private-hostname guard,
  // which would reject the internal Service name. Pin x-forwarded-host to
  // the exact hostname the API tier's own guard already validated for this
  // request (it reads x-forwarded-host first, then host) so the worker
  // guard accepts the same value — and collapses any client-supplied
  // multi-value list to that single trusted hostname.
  const forwardedHost = Array.isArray(headers["x-forwarded-host"])
    ? headers["x-forwarded-host"][0]
    : headers["x-forwarded-host"];
  const validatedHost = (forwardedHost ?? headers["host"])?.split(",")[0]?.trim();
  if (validatedHost) {
    out.set("x-forwarded-host", validatedHost);
  } else {
    out.delete("x-forwarded-host");
  }
  return out;
}

function hasRequestBody(req: Request): boolean {
  return req.method !== "GET" && req.method !== "HEAD";
}

/**
 * Build an Express handler that reverse-proxies the request to the worker
 * tier at `workersInternalUrl`.
 */
function createWorkerProxyHandler(
  workersInternalUrl: string,
  streaming: boolean,
): RequestHandler {
  return async (req, res) => {
    const targetUrl = `${workersInternalUrl}${req.originalUrl}`;
    const controller = new AbortController();

    // Set when the downstream client goes away before we finished
    // responding. Distinguishes an expected teardown (no need to log or
    // reply) from a real worker-tier failure (must log + 502).
    let clientDisconnected = false;
    res.on("close", () => {
      if (!res.writableFinished) clientDisconnected = true;
      controller.abort();
    });

    // Non-streaming requests get a hard timeout; streaming (SSE) requests
    // stay open until the client disconnects.
    const timeout = streaming
      ? undefined
      : setTimeout(() => controller.abort(), PROXY_REQUEST_TIMEOUT_MS);

    try {
      const headers = forwardRequestHeaders(req.headers);
      let body: string | undefined;
      if (hasRequestBody(req)) {
        // express.json() already parsed the body; re-serialize as JSON.
        // Every allowlisted mutating route is a JSON endpoint.
        body = JSON.stringify(req.body ?? {});
        headers.set("content-type", "application/json");
      }

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });

      if (upstream.status >= 500) {
        // The worker tier reached us but failed the operation. Forward it
        // verbatim, but log so the failure is visible from API-tier logs.
        logger.warn(
          { targetUrl, method: req.method, status: upstream.status },
          "worker-tier proxy: worker tier returned a server error",
        );
      }

      res.status(upstream.status);
      for (const [name, value] of upstream.headers.entries()) {
        if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
        res.setHeader(name, value);
      }

      if (upstream.body) {
        await new Promise<void>((resolve, reject) => {
          const nodeStream = Readable.fromWeb(
            upstream.body as Parameters<typeof Readable.fromWeb>[0],
          );
          nodeStream.on("error", reject);
          res.on("error", reject);
          res.on("finish", resolve);
          nodeStream.pipe(res);
        });
      } else {
        res.end();
      }
    } catch (err) {
      // Client left before we finished — expected, nothing to report.
      if (clientDisconnected) return;
      logger.error(
        { err, targetUrl, method: req.method },
        "worker-tier proxy: failed to relay request to worker tier",
      );
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: "Worker tier unreachable — plugin operation could not be completed." });
      } else {
        // Headers already flushed: the response is now a truncated stream.
        // Destroy the socket so the client sees a broken connection rather
        // than a clean end it would mistake for a complete response.
        res.destroy(err instanceof Error ? err : undefined);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}

/**
 * Register reverse-proxy handlers for the worker-dependent plugin routes on
 * `router`. Must be called before the real plugin route handlers are
 * registered so Express matches the proxy first and the worker-bound
 * handlers never run on the API tier.
 */
export function registerWorkerTierProxyRoutes(
  router: Router,
  workersInternalUrl: string,
): void {
  for (const route of WORKER_DEPENDENT_PLUGIN_ROUTES) {
    router[route.method](
      route.path,
      createWorkerProxyHandler(workersInternalUrl, route.streaming ?? false),
    );
  }
  logger.info(
    { workersInternalUrl, routeCount: WORKER_DEPENDENT_PLUGIN_ROUTES.length },
    "worker-tier proxy: API tier will forward worker-dependent plugin routes",
  );
}

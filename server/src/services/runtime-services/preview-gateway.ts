import { createPreviewIngressVerifier, PREVIEW_AUTHORIZED_HEADER } from "./preview-ingress.js";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { Router, type Request, type RequestHandler } from "express";
import { runtimeServices, runtimeServiceAllocations, type Db } from "@paperclipai/db";
import { createRuntimeServiceShareSchema } from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { forbidden, HttpError, notFound, unauthorized } from "../../errors.js";
import { guardedRemoteHttpFetch } from "../remote-http-fetch.js";
import type { RuntimeServiceManager } from "./manager.js";
import { createPreviewAccess, PREVIEW_COOKIE, previewSignature } from "./preview-access.js";
import { previewPath, type RuntimeServicePreviewConfig } from "./preview-config.js";
import { previewPage, previewVisibilityScript } from "./preview-pages.js";
import { PREVIEW_INTERNAL_PATH, proxyPreviewHttp, proxyPreviewWebSocket } from "./preview-proxy.js";
import { createPreviewShares, SHARED_PREVIEW_PATH } from "./preview-shares.js";

type ServiceRow = typeof runtimeServices.$inferSelect;
type Scope = { companyId: string; serviceId: string; endpointName: string; origin: string; provider: string; row: ServiceRow };
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const navigation = (req: IncomingMessage) => req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
const proofValue = (scope: Scope, timestamp: string) => `${scope.companyId}:${scope.serviceId}:${scope.endpointName}:${scope.row.processRef?.generation}:${timestamp}`;
export interface RuntimeServicePreviewGateway {
  middleware: RequestHandler;
  routes: Router;
  publicRoutes: Router;
  access: ReturnType<typeof createPreviewAccess>;
  exposeEndpoint(row: ServiceRow, endpoint: { name: string; port: number }): Promise<{ url: string; verifiedAt: string | null; error: string | null }>;
  attach(server: Server): void;
}

export function createRuntimeServicePreviewGateway(db: Db, manager: RuntimeServiceManager, options: {
  config: RuntimeServicePreviewConfig; allowLocalBoard: boolean; boardBaseURL: () => string;
}): RuntimeServicePreviewGateway {
  const { config } = options;
  const ingress = createPreviewIngressVerifier(config);
  const access = createPreviewAccess(db, manager, { allowLocalBoard: options.allowLocalBoard });
  const shares = createPreviewShares(db, manager, options.boardBaseURL);
  function ownsHost(host: string | undefined) {
    // Reserve the entire namespace, including malformed/unknown endpoint IDs.
    // Requests must never fall through into Paperclip's API or authentication.
    let hostname: string;
    try { hostname = new URL(`http://${host ?? ""}`).hostname.toLowerCase().replace(/\.$/, ""); } catch { return false; }
    return hostname === config.base.hostname || hostname.endsWith(`.${config.base.hostname}`);
  }
  async function scopeForHost(host: string | undefined): Promise<Scope> {
    const match = config.match(host);
    if (!match) throw notFound("Preview not found");
    const [result] = await db.select({ row: runtimeServices, provider: runtimeServiceAllocations.provider }).from(runtimeServices)
      .innerJoin(runtimeServiceAllocations, and(eq(runtimeServiceAllocations.id, runtimeServices.allocationId), eq(runtimeServiceAllocations.companyId, runtimeServices.companyId)))
      .where(eq(runtimeServices.id, match.serviceId));
    if (!result || result.row.desiredState === "deleted") throw notFound("Preview not found");
    const matches = result.row.spec.endpoints.filter((endpoint) => new URL(config.origin(result.row.id, endpoint.name)).host === host);
    if (matches.length !== 1) throw notFound("Preview not found");
    const endpointName = matches[0]!.name;
    return { companyId: result.row.companyId, serviceId: result.row.id, endpointName, origin: config.origin(result.row.id, endpointName), ...result };
  }
  function boardURL(scope: Scope, path?: string) {
    const base = new URL(options.boardBaseURL());
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || ownsHost(base.host)) throw new Error("Invalid Paperclip preview handoff origin");
    const url = new URL(`/api/companies/${scope.companyId}/runtime-services/${scope.serviceId}/preview-access`, base);
    url.searchParams.set("endpoint", scope.endpointName);
    url.searchParams.set("next", previewPath(path));
    return url.toString();
  }
  async function readVisible(req: Request, origin: string) {
    if (req.headers.origin !== origin) throw forbidden("Preview activity requires the same origin");
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "Expected JSON");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 128) throw new HttpError(413, "Activity payload is too large");
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, "Invalid activity payload"); }
    if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || !("visible" in body) || typeof body.visible !== "boolean") throw new HttpError(400, "Invalid activity payload");
    return body.visible;
  }
  const middleware: RequestHandler = (req, res, next) => {
    if (!ownsHost(req.headers.host) && !ingress.claims(req)) { next(); return; }
    void (async () => {
      // A service worker could intercept a future one-time ticket on its own
      // origin. Block registration before routing either app or reserved URLs.
      if (req.headers["service-worker"] || req.headers["sec-fetch-dest"] === "serviceworker") throw forbidden("Service workers are unavailable on managed preview origins");
      const scope = await scopeForHost(ingress.host(req));
      if (!req.url.startsWith("/") || req.url.startsWith("//") || /[\\\r\n\0]/.test(req.url)) throw new HttpError(400, "Invalid preview path");
      const url = new URL(req.url, scope.origin);
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
      if (url.pathname === `${PREVIEW_INTERNAL_PATH}handoff` && req.method === "GET") {
        const session = await access.consume(scope, url.searchParams.get("ticket") ?? "");
        res.set("Set-Cookie", `${PREVIEW_COOKIE}=${session.token}; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=${session.expiresAt.toUTCString()}`);
        res.redirect(303, previewPath(url.searchParams.get("next"))); return;
      }
      if (url.pathname === `${PREVIEW_INTERNAL_PATH}verify` && req.method === "GET") {
        const timestamp = String(req.headers["x-paperclip-preview-time"] ?? "");
        const proof = String(req.headers["x-paperclip-preview-proof"] ?? "");
        if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30_000 || !safeEqual(proof, previewSignature(proofValue(scope, timestamp)))) throw unauthorized();
        // The provider validates process identity and endpoint health. The
        // signed response proves this request also traversed the public route.
        const upstream = await manager.upstream(scope.companyId, scope.serviceId, scope.endpointName);
        const endpoint = scope.row.spec.endpoints.find((e) => e.name === scope.endpointName)!;
        const target = new URL(endpoint.healthPath, upstream.url);
        if (target.origin !== new URL(upstream.url).origin) throw new Error("Invalid preview health path");
        const response = await guardedRemoteHttpFetch(target, {
          headers: upstream.headers, signal: AbortSignal.timeout(5_000),
        }, { allowPrivateNetwork: scope.provider === "local", error: () => new Error("Preview upstream verification failed"), responseTimeoutMs: 5_000 });
        await response.body?.cancel();
        if (response.status < 200 || response.status >= 400) throw new Error("Preview upstream verification failed");
        res.json({ proof: previewSignature(`response:${proof}`) }); return;
      }
      try { await access.authenticate(scope, req.headers.cookie); }
      catch (error) {
        if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error;
        if (navigation(req) && !url.pathname.startsWith(PREVIEW_INTERNAL_PATH)) { res.redirect(303, boardURL(scope, req.url)); return; }
        throw error;
      }
      // The edge's opaque proof is never sent to the app. Echo it only after
      // authorization as an activity acknowledgement, not on arbitrary success.
      const ingressProof = typeof req.headers["x-paperclip-preview-ingress-signature"] === "string" ? req.headers["x-paperclip-preview-ingress-signature"] : undefined;
      if (navigation(req) && ingressProof) res.set(PREVIEW_AUTHORIZED_HEADER, ingressProof);
      if (url.pathname.startsWith(PREVIEW_INTERNAL_PATH)) {
        if (url.pathname === `${PREVIEW_INTERNAL_PATH}visibility.js` && req.method === "GET") { res.type("application/javascript").send(previewVisibilityScript); return; }
        if (url.pathname === `${PREVIEW_INTERNAL_PATH}activity` && req.method === "POST") {
          const visible = await readVisible(req, scope.origin);
          if (visible) {
            await manager.wake(scope.companyId, scope.serviceId);
            if (ingressProof) res.set(PREVIEW_AUTHORIZED_HEADER, ingressProof);
          }
          await manager.previewActivity(scope.companyId, scope.serviceId, visible);
          res.status(204).end(); return;
        }
        if (url.pathname === `${PREVIEW_INTERNAL_PATH}status` && req.method === "GET") {
          const service = await manager.get(scope.companyId, scope.serviceId);
          res.json({ state: service.state, desiredState: service.desiredState, ready: service.desiredState === "running" && service.endpoints.some((e) => e.name === scope.endpointName && e.status === "ready") }); return;
        }
        throw notFound("Preview route not found");
      }
      const service = navigation(req) ? await manager.wake(scope.companyId, scope.serviceId) : await manager.get(scope.companyId, scope.serviceId);
      if (navigation(req)) await manager.activity(scope.companyId, scope.serviceId, true);
      if (service.desiredState !== "running" || !["ready", "unhealthy"].includes(service.state)) {
        const starting = service.desiredState === "running" && ["pending", "starting", "stopping"].includes(service.state);
        if (!navigation(req)) { res.status(503).set("Retry-After", "2").json({ error: "Preview is not running" }); return; }
        previewPage(res, { status: starting ? 200 : 503, title: starting ? "Starting your preview" : service.state === "failed" ? "Preview needs attention" : service.desiredState === "sleeping" ? "Preview is sleeping" : "Preview is stopped",
          message: starting ? "Your files are retained. The app will open here when it is ready." : "Open Paperclip to start this service explicitly or review its status.",
          boardURL: new URL(`/runtime-services/${scope.serviceId}`, options.boardBaseURL()).toString(), poll: starting }); return;
      }
      const upstream = await manager.upstream(scope.companyId, scope.serviceId, scope.endpointName);
      await proxyPreviewHttp({ req, res, upstream, provider: scope.provider, origin: scope.origin, authorize: async () => {
        await access.authenticate(scope, req.headers.cookie);
        const { service: current } = await manager.getRecord(scope.companyId, scope.serviceId);
        if (current.desiredState !== "running" || current.processRef?.generation !== scope.row.processRef?.generation || current.processRef?.retired) throw forbidden();
      } });
    })().catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 502;
      previewPage(res, { status, title: status === 404 ? "Preview not found" : status === 401 || status === 403 ? "Preview access required" : "Preview is unavailable",
        message: error instanceof HttpError ? error.message : "The app could not be reached. Retry shortly, or check its status in Paperclip." });
    });
  };
  const routes = Router();
  for (const name of ["companyId", "serviceId", "shareId"]) routes.param(name, (_req, _res, next, value) => next(z.string().guid().safeParse(value).success ? undefined : notFound("Preview not found")));
  routes.get("/companies/:companyId/runtime-services/:serviceId/shares", async (req, res) => { res.set("Cache-Control", "no-store").json(await shares.list(req, req.params.companyId as string, req.params.serviceId as string)); });
  routes.post("/companies/:companyId/runtime-services/:serviceId/shares", validate(createRuntimeServiceShareSchema), async (req, res) => { res.status(201).set("Cache-Control", "no-store").json(await shares.create(req, req.params.companyId as string, req.params.serviceId as string, req.body)); });
  routes.delete("/companies/:companyId/runtime-services/:serviceId/shares/:shareId", async (req, res) => { res.set("Cache-Control", "no-store").json(await shares.revoke(req, req.params.companyId as string, req.params.serviceId as string, req.params.shareId as string)); });
  routes.get("/companies/:companyId/runtime-services/:serviceId/preview-access", async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const endpoint = typeof req.query.endpoint === "string" ? req.query.endpoint : "";
    // Derivation followed by lookup ensures untrusted params never pick a
    // company, arbitrary endpoint, host, or redirect target independently.
    if (!/^[a-f0-9-]{36}$/.test(req.params.serviceId as string)) throw notFound("Preview not found");
    const scope = await scopeForHost(new URL(config.origin(req.params.serviceId as string, endpoint)).host);
    if (scope.companyId !== req.params.companyId || scope.endpointName !== endpoint) throw notFound("Preview not found");
    try {
      const ticket = await access.grant(req, scope);
      const target = new URL(`${PREVIEW_INTERNAL_PATH}handoff`, scope.origin);
      target.searchParams.set("ticket", ticket); target.searchParams.set("next", previewPath(req.query.next));
      res.redirect(303, target.toString());
    } catch (error) {
      if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error;
      if (req.actor.type !== "none" && error.status === 403) {
        previewPage(res, { status: 403, title: "Preview access required",
          message: "Your account does not have access to this preview. Ask a company administrator for access.",
          boardURL: new URL("/", options.boardBaseURL()).toString() });
        return;
      }
      const continuation = new URL(boardURL(scope, previewPath(req.query.next)));
      const login = new URL("/auth", continuation.origin);
      login.searchParams.set("next", continuation.pathname + continuation.search);
      previewPage(res, { status: error.status, title: "Sign in to open this preview",
        message: "Sign in to Paperclip to continue to this preview.", boardURL: login.toString() });
    }
  });
  const publicRoutes = Router();
  // Capability URLs are never passed through the control-plane HTTP logger.
  publicRoutes.get("/runtime-previews/shared/:serviceId/:endpoint/:token", async (req, res) => {
    try {
      if (!z.string().guid().safeParse(req.params.serviceId).success || !/^[A-Za-z0-9_-]{43}$/.test(req.params.token as string)) throw notFound("Share link not found");
      const scope = await scopeForHost(new URL(config.origin(req.params.serviceId as string, req.params.endpoint as string)).host);
      const ticket = await access.grantShare(scope, req.params.token as string);
      const target = new URL(`${PREVIEW_INTERNAL_PATH}handoff`, scope.origin); target.searchParams.set("ticket", ticket);
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).redirect(303, target.toString());
    } catch {
      previewPage(res, { status: 404, title: "Share link unavailable", message: "This link has expired, was revoked, or no longer points to an available preview." });
    }
  });
  publicRoutes.use(SHARED_PREVIEW_PATH, (_req, res) => { previewPage(res, { status: 404, title: "Share link unavailable", message: "Check the complete share link." }); });
  return {
    middleware, routes, publicRoutes, access,
    async exposeEndpoint(row: ServiceRow, endpoint: { name: string; port: number }) {
      const origin = config.origin(row.id, endpoint.name);
      try {
        const scope = await scopeForHost(new URL(origin).host);
        const timestamp = String(Date.now());
        const proof = previewSignature(proofValue(scope, timestamp));
        const response = await guardedRemoteHttpFetch(`${origin}${PREVIEW_INTERNAL_PATH}verify`, {
          headers: { "x-paperclip-preview-time": timestamp, "x-paperclip-preview-proof": proof }, signal: AbortSignal.timeout(8_000),
        }, { allowPrivateNetwork: config.local, ...(config.local ? { lookup: async () => [{ address: "127.0.0.1", family: 4 }] } : {}), error: () => new Error("Preview verification failed"), responseTimeoutMs: 8_000 });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw new Error("Preview verification failed"); }
        const body = await response.text();
        if (body.length > 1024 || !safeEqual(JSON.parse(body).proof ?? "", previewSignature(`response:${proof}`))) throw new Error("Preview verification failed");
        return { url: origin, verifiedAt: new Date().toISOString(), error: null };
      } catch { return { url: origin, verifiedAt: null, error: "Preview route could not be verified. Check gateway routing and service health." }; }
    },
    attach(server: Server) {
      server.prependListener("upgrade", (req: IncomingMessage & { paperclipWebSocketHandled?: boolean }, client, head) => {
        if (!ownsHost(req.headers.host) && !ingress.claims(req)) return;
        req.paperclipWebSocketHandled = true;
        client.on("error", () => {});
        void (async () => {
          const scope = await scopeForHost(ingress.host(req));
          if (req.headers.origin !== scope.origin || req.headers.upgrade?.toLowerCase() !== "websocket" || !req.url?.startsWith("/") || req.url.startsWith("//") || new URL(req.url, scope.origin).pathname.startsWith(PREVIEW_INTERNAL_PATH)) throw forbidden();
          const generation = scope.row.processRef?.generation;
          const authorize = async () => {
            await access.authenticate(scope, req.headers.cookie);
            const { service } = await manager.getRecord(scope.companyId, scope.serviceId);
            if (service.desiredState !== "running" || service.processRef?.generation !== generation || service.processRef?.retired) throw forbidden();
          };
          await authorize();
          const upstream = await manager.upstream(scope.companyId, scope.serviceId, scope.endpointName);
          await proxyPreviewWebSocket({ req, client, head, upstream, provider: scope.provider, origin: scope.origin, authorize, ingressProof: typeof req.headers["x-paperclip-preview-ingress-signature"] === "string" ? req.headers["x-paperclip-preview-ingress-signature"] : undefined });
        })().catch(() => { if (!client.destroyed) { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } });
      });
    },
  };
}

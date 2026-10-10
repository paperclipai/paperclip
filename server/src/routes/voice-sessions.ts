import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { isUuidLike, startVoiceSessionSchema, voiceCallbackPreferenceSchema, voicePhoneConfigurationSchema, voiceInboundDecisionSchema } from "@paperclipai/shared";
import { badRequest, forbidden, HttpError, tooManyRequests } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import { SpekoProtocolError } from "../services/voice/speko-protocol.js";
import type { VoiceSessionService } from "../services/voice/voice-session-service.js";
import type { VoiceCaller } from "../services/voice/voice-session-store.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function caller(req: Request): VoiceCaller {
  assertBoard(req);
  if (req.actor.source === "local_implicit") return { id: "local-board", authority: "local_board" };
  if (!req.actor.userId || req.actor.source !== "session") throw forbidden("Sign in to start a private voice conversation");
  return { id: req.actor.userId, authority: req.actor.isInstanceAdmin ? "instance_admin" : "member" };
}
function company(req: Request, requireAccess = true) {
  const id = req.params.companyId as string;
  if (!isUuidLike(id)) throw badRequest("Invalid company id");
  assertBoard(req);
  if (requireAccess) assertCompanyAccess(req, id);
  return id;
}
function session(req: Request) {
  const id = req.params.sessionId as string;
  if (!isUuidLike(id)) throw badRequest("Invalid voice session id");
  return id;
}
export function voiceSessionRoutes(db: Db, service: VoiceSessionService) {
  const router = Router(), settings = instanceSettingsService(db);
  const starts = createInviteRateLimiter({ windowMs: 60_000, maxRequests: 10 });
  async function enabled() {
    if (!(await settings.getExperimental()).enableChatConnectors) throw forbidden("Enable experimental chat connectors to use voice");
  }
  router.use("/companies/:companyId/voice-sessions", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/companies/:companyId/voice-callbacks/:endpointId", async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); await enabled();
    if (!isUuidLike(req.params.endpointId as string)) throw badRequest("Invalid voice endpoint id");
    res.json(await service.callbackPreference(company(req), req.params.endpointId as string, caller(req)));
  });
  router.put("/companies/:companyId/voice-callbacks/:endpointId", validate(voiceCallbackPreferenceSchema), async (req, res) => {
    res.setHeader("Cache-Control", "no-store"); await enabled();
    if (!isUuidLike(req.params.endpointId as string)) throw badRequest("Invalid voice endpoint id");
    res.json(await service.saveCallbackPreference(company(req), req.params.endpointId as string, caller(req), req.body));
  });
  router.use("/companies/:companyId/voice-phone/:endpointId", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  function endpoint(req: Request) { const id = req.params.endpointId as string; if (!isUuidLike(id)) throw badRequest("Invalid voice endpoint id"); return id; }
  router.get("/companies/:companyId/voice-phone/:endpointId", async (req, res) => { res.json(await service.inbound.configuration(company(req), endpoint(req), caller(req))); });
  router.put("/companies/:companyId/voice-phone/:endpointId", validate(voicePhoneConfigurationSchema), async (req, res) => { res.json(await service.inbound.saveConfiguration(company(req), endpoint(req), caller(req), req.body)); });
  router.get("/companies/:companyId/voice-phone/:endpointId/incoming", async (req, res) => { res.json(await service.inbound.list(company(req), endpoint(req), caller(req))); });
  router.get("/companies/:companyId/voice-phone/:endpointId/history", async (req, res) => { res.json(await service.inbound.history(company(req), endpoint(req), caller(req))); });
  router.post("/companies/:companyId/voice-phone/:endpointId/incoming/:callId", validate(voiceInboundDecisionSchema), async (req, res) => {
    if (!isUuidLike(req.params.callId as string)) throw badRequest("Invalid incoming call id");
    const companyId = company(req), actor = caller(req);
    if (!starts.consume(`inbound:${companyId}:${actor.id}`).allowed) throw tooManyRequests("Too many incoming call approval attempts");
    res.json(await service.inbound.decide(companyId, endpoint(req), req.params.callId as string, actor, req.body));
  });
  router.get("/companies/:companyId/voice-history/:endpointId", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isUuidLike(req.params.endpointId as string)) throw badRequest("Invalid voice endpoint id");
    res.json(await service.history(company(req), req.params.endpointId as string, caller(req)));
  });
  router.get("/companies/:companyId/voice-sessions/:sessionId/report", async (req, res) => {
    res.json(await service.callDetail(company(req), session(req), caller(req)));
  });
  router.post("/companies/:companyId/voice-sessions", validate(startVoiceSessionSchema), async (req, res) => {
    const companyId = company(req), actor = caller(req);
    await enabled();
    const limit = starts.consume(`${companyId}:${actor.id}`);
    if (!limit.allowed) throw tooManyRequests("Too many voice session attempts");
    const result = await service.start({ ...req.body, companyId, caller: actor });
    res.status(result.media ? 201 : 200).json(result);
  });
  router.get("/companies/:companyId/voice-sessions/:sessionId", async (req, res) => {
    res.json(await service.inspect(company(req), session(req), caller(req)));
  });
  router.post("/companies/:companyId/voice-sessions/:sessionId/end", async (req, res) => {
    res.json(await service.end(company(req, false), session(req), caller(req)));
  });
  router.get("/companies/:companyId/voice-sessions/:sessionId/notification", async (req, res) => {
    const companyId = company(req), actor = caller(req);
    await enabled();
    res.json(await service.notification(companyId, session(req), actor.id));
  });
  return router;
}

/** Original bytes + provider signature + per-session capability; no board bypass. */
export function voiceWebhookRoutes(db: Db, service: VoiceSessionService) {
  const router = Router(), settings = instanceSettingsService(db);
  const limiter = createInviteRateLimiter({ windowMs: 60_000, maxRequests: 600 });
  router.post("/api/voice-webhooks/:publicId/events", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!limiter.consume(req.ip ?? req.socket.remoteAddress ?? "unknown").allowed) throw tooManyRequests("Too many voice callbacks");
    const body = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(body)) throw badRequest("Original callback body is required");
    try { res.json(await service.inbound.lifecycle(req.params.publicId as string, body, req.headers)); }
    catch (error) {
      if (error instanceof SpekoProtocolError) throw new HttpError(error.code === "body_too_large" ? 413 : error.code === "invalid_signature" ? 401 : 400, "Invalid voice callback");
      if (error instanceof SyntaxError || error instanceof Error && error.name === "ZodError") throw badRequest("Invalid voice callback");
      throw error;
    }
  });
  router.post("/api/voice-webhooks/:publicId/tools", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const limit = limiter.consume(req.ip ?? req.socket.remoteAddress ?? "unknown");
    if (!limit.allowed) throw tooManyRequests("Too many voice callbacks");
    if (!(await settings.getExperimental()).enableChatConnectors) throw forbidden("Voice connections are disabled");
    const body = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!Buffer.isBuffer(body)) throw badRequest("Original callback body is required");
    try { res.json(await service.tool(req.params.publicId as string, body, req.headers)); }
    catch (error) {
      if (error instanceof SpekoProtocolError) throw new HttpError(error.code === "body_too_large" ? 413 : error.code === "invalid_signature" ? 401 : 400, "Invalid voice callback");
      throw error;
    }
  });
  return router;
}

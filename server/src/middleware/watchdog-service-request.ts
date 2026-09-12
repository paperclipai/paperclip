import type { Request } from "express";
import { activityLog, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { loadWatchdogServiceContext, watchdogSignalOrigin, assertWatchdogCommentTarget, type WatchdogServiceContext } from "../services/watchdog-service-context.js";

const contexts = new WeakMap<Request, WatchdogServiceContext>();
export const trustedWatchdogContext = (req: Request) => contexts.get(req);

const origins = new WeakMap<Request, ReturnType<typeof watchdogSignalOrigin>>();
export const trustedWatchdogOrigin = (req: Request) => origins.get(req) ?? {};

export async function assertWatchdogServiceRequest(db: Db, req: Request): Promise<void> {
  if (req.actor.type !== "agent") return;
  const context = await loadWatchdogServiceContext(db, req.actor);
  if (!context) return;
  contexts.set(req, context);
  try {
    const path = req.path;
    const body = req.body ?? {};
    if (req.method === "GET" && (
      path === `/api/agents/${context.agentId}` ||
      path === `/api/companies/${context.companyId}/issues` ||
      /^\/api\/issues\/[0-9a-f-]+(?:\/comments)?$/.test(path)
    )) return;
    if (Object.keys(req.query).length !== 0) throw forbidden("Watchdog writes do not accept query parameters.");
    if (req.method === "POST" && /^\/api\/agents\/me\/secrets\/[^/]+\/value$/.test(path) && Object.keys(body).length === 0) return;
    if (req.method === "POST" && path === `/api/companies/${context.companyId}/issues`) {
      origins.set(req, watchdogSignalOrigin(context, body));
      return;
    }
    const match = /^\/api\/issues\/([0-9a-f-]+)\/comments$/.exec(path);
    if (req.method === "POST" && match && typeof body.body === "string" &&
        Object.keys(body).length === 1) {
      const signal = await assertWatchdogCommentTarget(db, context, match[1]!);
      if (!body.body.includes(signal.marker)) throw forbidden("Comment does not match the configured watchdog signal.");
      return;
    }
    throw forbidden("Watchdog runs may only read their bound secret and report configured signals.");
  } catch (error) {
    await db.insert(activityLog).values({ companyId: context.companyId, actorType: "agent", actorId: context.agentId,
      agentId: context.agentId, runId: context.runId, action: "watchdog.service_action_rejected",
      entityType: "agent", entityId: context.agentId, details: { method: req.method, path: req.path } });
    throw error;
  }
}

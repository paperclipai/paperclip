import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler } from "express";
import { isPostHogDirectDeliveryEnabled, resolveCloudPostHogConfig } from "../cloud-posthog-config.js";
import { scopedTelemetryCompanyId, scopedTelemetryPerson } from "../../telemetry-company-scope.js";

/**
 * Request-scoped analytics context for Paperclip Cloud direct delivery.
 *
 * The store holds the live request so the acting user is read from the
 * authenticated actor when an event is tracked, whichever middleware set it.
 * The posthog-js tracing headers only link an event to a browser session and
 * window. They never identify a person and never authorize anything.
 */
type PostHogRequestStore = {
  req: Request;
  sessionId: string | null;
  windowId: string | null;
  // False once the response finishes. Work that outlives its request (timers,
  // background loops started during the request) must not keep attributing
  // events to that request's user or session.
  active: boolean;
};

export type PostHogAttribution = "request" | "task_creator" | "task_assigner" | "run_owner" | "none";

export type PostHogEventContext = {
  userId?: string;
  attributedVia?: PostHogAttribution;
  companyId?: string;
  sessionId?: string;
  windowId?: string;
};

export const POSTHOG_SESSION_ID_HEADER = "x-posthog-session-id";
export const POSTHOG_WINDOW_ID_HEADER = "x-posthog-window-id";

const storage = new AsyncLocalStorage<PostHogRequestStore>();
const TRACING_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function readTracingHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed && TRACING_ID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Express middleware that opens the request-scoped context. Mount it only on
 * a Cloud stack with direct delivery on; self-hosted servers never mount it,
 * so their requests carry no session context and the headers are ignored.
 */
export function postHogRequestContextMiddleware(): RequestHandler {
  return (req, res, next) => {
    const store: PostHogRequestStore = {
      req,
      sessionId: readTracingHeader(req, POSTHOG_SESSION_ID_HEADER),
      windowId: readTracingHeader(req, POSTHOG_WINDOW_ID_HEADER),
      active: true,
    };
    const end = () => {
      store.active = false;
    };
    res.once("finish", end);
    res.once("close", end);
    storage.run(store, next);
  };
}

/**
 * The request-context middleware for this process, or null when direct
 * delivery is off (every self-hosted install, a Cloud stack without a token
 * or environment, or the PAPERCLIP_POSTHOG_DIRECT=0 kill switch).
 */
export function postHogRequestContextMiddlewareForEnv(
  env: Record<string, string | undefined> = process.env,
): RequestHandler | null {
  return isPostHogDirectDeliveryEnabled(resolveCloudPostHogConfig(env)) ? postHogRequestContextMiddleware() : null;
}

function actingUserId(req: Request): string | undefined {
  const actor = req.actor;
  if (!actor || actor.type !== "board" || !actor.userId) return undefined;
  // Local implicit and Cloud control actors are not a signed-in person.
  if (actor.source === "local_implicit" || actor.source === "cloud_control") return undefined;
  return actor.userId;
}

/**
 * The company the request acts in, when the request itself says so: an agent
 * actor's company, the route's `:companyId`, or else the board actor's only
 * company (a Cloud stack usually has one). A board user with several companies
 * on a route without `:companyId` has no known company.
 */
function knownCompanyId(req: Request): string | undefined {
  if (req.actor?.companyId) return req.actor.companyId;
  const fromParams = (req.params as Record<string, unknown> | undefined)?.companyId;
  if (typeof fromParams === "string" && fromParams) return fromParams;
  const companyIds = req.actor?.companyIds;
  return companyIds?.length === 1 ? companyIds[0] : undefined;
}

/** Snapshot of the current request's analytics context, taken at track time. */
export function capturePostHogEventContext(): PostHogEventContext | undefined {
  const store = storage.getStore();
  const context: PostHogEventContext = {};
  if (store?.active) {
    const userId = actingUserId(store.req);
    const companyId = knownCompanyId(store.req);
    if (userId) {
      context.userId = userId;
      context.attributedVia = "request";
    }
    if (companyId) context.companyId = companyId;
    if (store.sessionId) context.sessionId = store.sessionId;
    if (store.windowId) context.windowId = store.windowId;
  }
  if (!context.userId) {
    const person = scopedTelemetryPerson();
    if (person) {
      context.userId = person.userId;
      context.attributedVia = person.attributedVia;
    }
  }
  if (!context.companyId) {
    const scopedCompanyId = scopedTelemetryCompanyId();
    if (scopedCompanyId) context.companyId = scopedCompanyId;
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { OnboardingIncidentsService } from "../services/onboarding-incidents.js";
import { logger } from "./logger.js";

const ONBOARDING_REFERER_PREFIX = "/onboarding";
const ONBOARDING_HEADER = "x-paperclip-onboarding";

type RoutePattern = { method: string; pattern: RegExp; canonical: string };

const ONBOARDING_ROUTE_PATTERNS: RoutePattern[] = [
  routePattern("POST", "/api/companies"),
  routePattern("POST", "/api/companies/:companyId/goals"),
  routePattern("POST", "/api/companies/:companyId/agents"),
  routePattern("POST", "/api/companies/:companyId/agents/:agentId/adapter-environment-test"),
  routePattern("POST", "/api/companies/:companyId/projects"),
  routePattern("POST", "/api/companies/:companyId/issues"),
];

function routePattern(method: string, canonical: string): RoutePattern {
  const escaped = canonical
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/:([A-Za-z0-9_]+)/g, "/[^/]+");
  return {
    method: method.toUpperCase(),
    pattern: new RegExp(`^${escaped}(?:\\?.*)?$`),
    canonical,
  };
}

function pathOnly(url: string | undefined): string {
  if (!url) return "";
  const idx = url.indexOf("?");
  return idx >= 0 ? url.slice(0, idx) : url;
}

function refererPath(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  try {
    const parsed = new URL(headerValue, "http://localhost");
    return parsed.pathname;
  } catch {
    return null;
  }
}

const COMPANY_ID_RE = /^\/api\/companies\/([0-9a-fA-F-]{32,36})(?:[\/?].*)?$/;

function resolveCompanyIdFromUrl(originalUrl: string): string | null {
  const path = pathOnly(originalUrl);
  const match = COMPANY_ID_RE.exec(path);
  return match ? match[1] : null;
}

function matchOnboardingRoute(method: string, url: string): RoutePattern | null {
  const upper = method.toUpperCase();
  const path = pathOnly(url);
  for (const route of ONBOARDING_ROUTE_PATTERNS) {
    if (route.method !== upper) continue;
    if (route.pattern.test(path)) return route;
  }
  return null;
}

function isOnboardingHeaderTruthy(value: string | string[] | undefined): boolean {
  const flat = Array.isArray(value) ? value[0] : value;
  if (!flat) return false;
  const normalized = flat.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

interface OnboardingClassification {
  isOnboarding: boolean;
  routePattern: string;
}

export function classifyOnboardingRequest(req: Request): OnboardingClassification {
  const allowlistHit = matchOnboardingRoute(req.method, req.originalUrl);
  const headerHit = isOnboardingHeaderTruthy(req.header(ONBOARDING_HEADER) as string | undefined);
  const refPath = refererPath(req.header("referer"));
  const refererHit = refPath ? refPath.startsWith(ONBOARDING_REFERER_PREFIX) : false;
  const isOnboarding = Boolean(allowlistHit) || headerHit || refererHit;
  const routePattern = allowlistHit?.canonical ?? pathOnly(req.originalUrl) ?? req.path;
  return { isOnboarding, routePattern };
}

interface ErrorContextSnapshot {
  error: { name?: string; message: string; stack?: string };
  reqBody: unknown;
}

function readErrorContext(res: Response): ErrorContextSnapshot | null {
  const ctx = (res as unknown as { __errorContext?: { error?: ErrorContextSnapshot["error"]; reqBody?: unknown } }).__errorContext;
  if (!ctx || !ctx.error) return null;
  return { error: ctx.error, reqBody: ctx.reqBody };
}

export interface OnboardingIncidentReporterDeps {
  incidents: OnboardingIncidentsService;
  generateIncidentId?: () => string;
  /**
   * Test-only hook fired after a recordIncident call resolves or rejects.
   * Lets vitest await the finish-hook side effect deterministically.
   */
  onRecordSettled?: (result: {
    incidentId: string;
    ok: boolean;
    error?: unknown;
    outcome?: { filed: string; issueId?: string };
  }) => void;
}

export function onboardingIncidentReporter(deps: OnboardingIncidentReporterDeps): RequestHandler {
  const generateIncidentId = deps.generateIncidentId ?? randomUUID;
  return (req: Request, res: Response, next: NextFunction) => {
    const classification = classifyOnboardingRequest(req);
    if (!classification.isOnboarding) {
      next();
      return;
    }

    const incidentId = generateIncidentId();
    res.locals.onboardingIncidentId = incidentId;

    const originalJson = res.json.bind(res);
    let jsonInjected = false;
    res.json = function patchedJson(body: unknown) {
      if (
        !jsonInjected
        && res.statusCode >= 500
        && body
        && typeof body === "object"
        && !Array.isArray(body)
        && !(body instanceof Buffer)
      ) {
        jsonInjected = true;
        const next = { ...(body as Record<string, unknown>) };
        if (!("incidentId" in next)) next.incidentId = incidentId;
        return originalJson(next);
      }
      return originalJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode < 500) return;
      const ctx = readErrorContext(res);
      const errorPayload = ctx?.error ?? {
        name: "Error",
        message: `HTTP ${res.statusCode}`,
        stack: undefined,
      };
      const reqBody = ctx?.reqBody ?? req.body ?? null;
      const companyId = resolveCompanyIdFromUrl(req.originalUrl);

      void deps.incidents
        .recordIncident({
          incidentId,
          method: req.method,
          routePattern: classification.routePattern,
          requestUrl: req.originalUrl,
          reqBody,
          reqHeaders: req.headers as Record<string, string | string[] | undefined>,
          error: {
            name: errorPayload.name,
            message: errorPayload.message,
            stack: errorPayload.stack,
          },
          companyId,
          createdByUserId: req.actor?.userId ?? null,
          actorSource: req.actor?.source ?? null,
        })
        .then((outcome) => {
          deps.onRecordSettled?.({
            incidentId,
            ok: true,
            outcome: { filed: outcome.filed, issueId: outcome.issueId },
          });
        })
        .catch((err) => {
          logger.error({ err, incidentId }, "Onboarding incident recorder threw");
          deps.onRecordSettled?.({ incidentId, ok: false, error: err });
        });
    });

    next();
  };
}

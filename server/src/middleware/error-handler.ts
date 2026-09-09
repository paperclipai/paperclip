import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { captureException } from "../sentry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";
import { logger } from "./logger.js";
import {
  recordResponsibleUserDenialOnActiveRun,
  rememberResponsibleUserDenialForRun,
} from "../services/responsible-user-denial-run-outcomes.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function isRedactedSkillPolicyDenial(details: Record<string, unknown> | null) {
  return details?.code === "skill_policy_denied";
}

function readZodIssues(err: unknown): unknown[] | null {
  if (err instanceof ZodError) return err.issues;
  if (!err || typeof err !== "object" || (err as { name?: unknown }).name !== "ZodError") return null;
  const issues = (err as { issues?: unknown }).issues;
  return Array.isArray(issues) ? issues : null;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

/** Report a server-side crash to every error sink. */
function reportCrash(error: Error): void {
  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: error.name });
  captureException(error);
}

function getPaperclipDb(req: Request): Db | null {
  const locals = req.app?.locals as { paperclipDb?: Db; db?: Db } | undefined;
  return locals?.paperclipDb ?? locals?.db ?? null;
}

type ResponsibleUserDenialRecording = "not_applicable" | "recorded" | "failed";

function isResponsibleUserDenial(
  req: Request,
  details: Record<string, unknown> | null,
): boolean {
  if (req.actor?.type !== "agent") return false;
  if (!getPaperclipDb(req)) return false;
  const code = details?.code;
  return code === "RESPONSIBLE_USER_UNAUTHORIZED" || code === "RESPONSIBLE_USER_UNAVAILABLE";
}

async function recordResponsibleUserDenialFromHttpError(
  req: Request,
  details: Record<string, unknown> | null,
): Promise<ResponsibleUserDenialRecording> {
  if (req.actor?.type !== "agent") return "not_applicable";
  const db = getPaperclipDb(req);
  if (!db) return "not_applicable";

  const code = details?.code;
  if (code !== "RESPONSIBLE_USER_UNAUTHORIZED" && code !== "RESPONSIBLE_USER_UNAVAILABLE") {
    return "not_applicable";
  }

  const runId = req.actor.runId?.trim() ?? "";

  try {
    const recorded = await recordResponsibleUserDenialOnActiveRun(db, {
      runId: runId || null,
      agentId: req.actor.agentId ?? null,
      companyId: req.actor.companyId ?? null,
      code,
    });
    if (recorded) return "recorded";
    if (!runId) {
      // The caller is an agent token used outside a heartbeat run. There is no
      // run to poison and no continuation loop to restart, so the denial stays
      // an ordinary handled client error.
      return "not_applicable";
    }
    // A run id was presented but no active run matched it, so the denial code
    // was not persisted anywhere. Treat that exactly like a write failure.
    logger.error(
      { runId, agentId: req.actor.agentId ?? null, code },
      "responsible-user denial not recorded: no active heartbeat run matched the request run id",
    );
    return "failed";
  } catch (recordErr) {
    const agentId = req.actor?.type === "agent" ? req.actor.agentId ?? null : null;
    // Once the primary durable write fails, establish an independent in-process
    // fail-closed signal before retrying. The adapter cannot observe this HTTP
    // response and exit before the heartbeat finalizer can see that signal.
    if (runId) rememberResponsibleUserDenialForRun(runId, code);
    logger.error(
      { err: recordErr, runId: runId || null, agentId },
      "failed to record responsible-user denial on heartbeat run",
    );
    // The rejected write says nothing about the next one: these are independent,
    // non-transactional statements that may land on different pooled
    // connections. Retry the durable denial marker once, but deliberately leave
    // the run live. Adapter finalization owns the terminal status together with
    // wakeup settlement, issue-lock release, and agent-status cleanup; changing
    // the status here would make that finalizer return before those side effects.
    if (runId) {
      try {
        await recordResponsibleUserDenialOnActiveRun(db, {
          runId,
          agentId,
          companyId: req.actor?.type === "agent" ? req.actor.companyId ?? null : null,
          code,
        });
      } catch (fallbackErr) {
        logger.error(
          { err: fallbackErr, runId, agentId },
          "failed the fallback attempt to record responsible-user denial on heartbeat run",
        );
      }
    }
    return "failed";
  }
}

function respondToHttpError(
  err: HttpError,
  req: Request,
  res: Response,
  details: Record<string, unknown> | null,
) {
  const redactedSkillPolicyDenial = isRedactedSkillPolicyDenial(details);
  const workspaceRepairPreconditionFailure = details?.code === "workspace_repair_precondition_failed";
  const structuredConnectionError = new Set([
    "user_authorization_required",
    "organization_authorization_required",
    "grant_audience_denied",
    "grant_revoked",
    "needs_reauthorization",
    "installation_required",
    "connection_not_installed",
    "subject_not_permitted",
    "standing_delegation_required",
    "grant_owner_membership_inactive",
  ]).has(typeof details?.code === "string" ? details.code : "");
  if (err.status >= 500) {
    attachErrorContext(
      req,
      res,
      { message: err.message, stack: err.stack, name: err.name, details: err.details },
      err,
    );
    reportCrash(err);
  }
  res.status(err.status).json({
    error: err.message,
    ...(typeof details?.code === "string" ? { code: details.code } : {}),
    ...(redactedSkillPolicyDenial && typeof details?.reason === "string" ? { reason: details.reason } : {}),
    ...(workspaceRepairPreconditionFailure && typeof details?.reason === "string" ? { reason: details.reason } : {}),
    ...(workspaceRepairPreconditionFailure && typeof details?.repairPhase === "string"
      ? { repairPhase: details.repairPhase }
      : {}),
    ...(typeof details?.remediation === "string" || (structuredConnectionError && details?.remediation && typeof details.remediation === "object")
      ? { remediation: details.remediation }
      : {}),
    ...(structuredConnectionError && details?.connection ? { connection: details.connection } : {}),
    ...(structuredConnectionError && details?.subject ? { subject: details.subject } : {}),
    ...(structuredConnectionError && typeof details?.grantId === "string" ? { grantId: details.grantId } : {}),
    ...(!redactedSkillPolicyDenial && !workspaceRepairPreconditionFailure && err.details
      ? { details: err.details }
      : {}),
  });
}

async function handleResponsibleUserDenial(
  err: HttpError,
  req: Request,
  res: Response,
  details: Record<string, unknown> | null,
) {
  const denialRecording = await recordResponsibleUserDenialFromHttpError(req, details);
  if (denialRecording === "failed") {
    // The denial itself is non-retryable, but nothing durable now records it.
    // Answering with the plain 403 would let the adapter treat the call as a
    // handled client error and finish the run cleanly, which is exactly the
    // state that lets continuation recovery restart the same denial loop.
    // Fail the request instead so the run cannot finalize as `succeeded`.
    //
    // A thrown first write gets one independent fallback attempt before this
    // response. When that attempt succeeds, it leaves the run live with the
    // denial code recorded; adapter finalization then fails the run and performs
    // all terminal cleanup. A no-match means the run is already terminal.
    res.status(503).json({
      error: err.message,
      code: "responsible_user_denial_not_recorded",
    });
    return;
  }
  respondToHttpError(err, req, res, details);
}

// Only the responsible-user denial path is asynchronous: the denial has to be
// durably recorded before the caller learns the request failed. Every other
// error keeps answering synchronously, the way Express middleware expects.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void | Promise<void> {
  if (err instanceof HttpError) {
    const details = err.details && typeof err.details === "object" && !Array.isArray(err.details)
      ? err.details as Record<string, unknown>
      : null;
    if (isResponsibleUserDenial(req, details)) {
      return handleResponsibleUserDenial(err, req, res, details).catch((responseErr) => {
        logger.error({ err: responseErr }, "failed to answer responsible-user denial");
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        }
      });
    }
    respondToHttpError(err, req, res, details);
    return;
  }

  const zodIssues = readZodIssues(err);
  if (zodIssues) {
    res.status(400).json({ error: "Validation error", details: zodIssues });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  reportCrash(rootError);

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req) ? { message: rootError.message } : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return req.actor?.source === "cloud_tenant"
    && req.method === "POST"
    && req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH;
}

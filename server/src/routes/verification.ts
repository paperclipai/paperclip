import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, verificationRuns } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { assertBoard } from "./authz.js";
import { createVerificationWorker, type DeliverableType } from "../services/verification/verification-worker.js";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";

interface VerifyRequestBody {
  specPath?: unknown;
  deliverableType?: unknown;
  context?: unknown;
  targetUrl?: unknown;
  targetSha?: unknown;
}

const VALID_DELIVERABLE_TYPES = new Set<DeliverableType>([
  "url",
  "api",
  "migration",
  "cli",
  "config",
  "data",
  "lib_frontend",
  "lib_backend",
]);

function coerceDeliverableType(value: unknown): DeliverableType {
  if (typeof value !== "string" || !VALID_DELIVERABLE_TYPES.has(value as DeliverableType)) {
    throw badRequest(`invalid deliverableType: ${String(value)}`);
  }
  return value as DeliverableType;
}

function coerceContext(value: unknown): "anonymous" | "authenticated" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "anonymous" || value === "authenticated") return value;
  throw badRequest(`invalid context: ${String(value)}`);
}

function coerceString(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`missing required field: ${field}`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`invalid ${field}: must be a non-empty string`);
  }
  return value.trim();
}

const SPEC_PATH_PATTERN = /^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.(spec|test)\.(ts|js)$/;
const TARGET_URL_PATTERN = /^https:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:\/[^\s]*)?$/;

function validateSpecPath(value: string): string {
  if (!SPEC_PATH_PATTERN.test(value)) {
    throw badRequest(
      `invalid specPath: must match skills/acceptance-<product>/tests/<name>.<spec|test>.<ts|js>`,
    );
  }
  return value;
}

function validateTargetUrl(value: string): string {
  if (!TARGET_URL_PATTERN.test(value)) {
    throw badRequest(`invalid targetUrl: must be an https URL`);
  }
  return value;
}

function validateTargetSha(value: string): string {
  if (!/^[a-f0-9]{7,40}$/.test(value)) {
    throw badRequest(`invalid targetSha: must be a 7-40 char hex string`);
  }
  return value;
}

export function verificationRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const worker = createVerificationWorker(db, storage);

  /**
   * POST /api/issues/:id/verify
   * Board-only. Synchronously runs the acceptance spec and returns the result.
   * Used in Phase 1 as a manual smoke-test endpoint before gates are wired.
   */
  router.post("/issues/:id/verify", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.id as string;

    const issue = await db
      .select({ id: issues.id, identifier: issues.identifier, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!issue) throw notFound("issue not found");

    const body = (req.body ?? {}) as VerifyRequestBody;
    const deliverableType = coerceDeliverableType(body.deliverableType);
    const specPath = validateSpecPath(coerceString(body.specPath, "specPath") as string);
    const context = coerceContext(body.context);
    const targetUrlRaw = coerceString(body.targetUrl, "targetUrl", deliverableType === "url");
    const targetUrl = targetUrlRaw ? validateTargetUrl(targetUrlRaw) : undefined;
    const targetShaRaw = coerceString(body.targetSha, "targetSha", deliverableType === "url");
    const targetSha = targetShaRaw ? validateTargetSha(targetShaRaw) : undefined;

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
      action: "issue.verification_run_started",
      entityType: "issue",
      entityId: issue.id,
      details: { deliverableType, specPath, context: context ?? null, trigger: "on_demand" },
    });

    const result = await worker.runSpec({
      issueId: issue.id,
      deliverableType,
      specPath,
      context,
      targetUrl,
      targetSha,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
      action: `issue.verification_run_${result.status}`,
      entityType: "issue",
      entityId: issue.id,
      details: {
        deliverableType,
        specPath,
        status: result.status,
        attempts: result.attempts,
        ...(result.status === "failed" && { failureSummary: result.failureSummary }),
        ...(result.status === "unavailable" && { unavailableReason: result.unavailableReason }),
      },
    });

    res.json({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      ...result,
    });
  });

  /**
   * GET /api/issues/:id/verification-runs
   * Board-only. Lists recent verification runs for an issue.
   */
  router.get("/issues/:id/verification-runs", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.id as string;
    const issue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!issue) throw notFound("issue not found");

    const runs = await db
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.issueId, issueId))
      .orderBy(desc(verificationRuns.startedAt))
      .limit(50);

    res.json({ runs });
  });

  return router;
}

import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, verificationRuns, verificationOverrides } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { assertBoard } from "./authz.js";
import { createVerificationWorker, type DeliverableType } from "../services/verification/verification-worker.js";
import { resolveEscalation, listOpenEscalations } from "../services/verification/escalation-sweeper.js";
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

/**
 * Spec path must live under an acceptance skill's tests/ directory. Each runner enforces a
 * stricter per-type regex on the filename suffix (playwright: *.spec.ts/js; api: *.api.spec.json;
 * migration: *.migration.spec.json), but at the route layer we only check the shared prefix
 * shape and reject obvious shell-meta characters.
 */
const SPEC_PATH_PATTERN = /^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+$/;
const TARGET_URL_PATTERN = /^https:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:\/[^\s]*)?$/;

function validateSpecPath(value: string): string {
  if (!SPEC_PATH_PATTERN.test(value)) {
    throw badRequest(
      `invalid specPath: must match skills/acceptance-<product>/tests/<filename>`,
    );
  }
  // Defense in depth: reject any shell metacharacters that may have slipped past the filename
  // regex via weird Unicode lookalikes.
  if (/[;&|`$(){}\[\]<>\\]/.test(value)) {
    throw badRequest(`invalid specPath: contains forbidden characters`);
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

  /**
   * POST /api/issues/:id/verification-override
   * Board-only. Creates a verification_overrides row with a mandatory ≥20 char justification,
   * marks the latest failed verification_run as overridden, and resolves any open escalations.
   *
   * This is the only way to close an issue that has a failing verification run when gate
   * enforcement is on. Every override is permanently logged to the activity feed.
   */
  router.post("/issues/:id/verification-override", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.id as string;
    const issue = await db
      .select({ id: issues.id, identifier: issues.identifier, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!issue) throw notFound("issue not found");

    const body = (req.body ?? {}) as { justification?: unknown };
    if (typeof body.justification !== "string" || body.justification.trim().length < 20) {
      throw badRequest("justification must be a string of at least 20 characters");
    }
    const justification = body.justification.trim();

    // Find the latest failed verification run (if any)
    const latestFailed = await db
      .select({ id: verificationRuns.id, status: verificationRuns.status })
      .from(verificationRuns)
      .where(eq(verificationRuns.issueId, issueId))
      .orderBy(desc(verificationRuns.startedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const userId = req.actor.type === "board" ? req.actor.userId ?? "board" : "board";

    const [override] = await db
      .insert(verificationOverrides)
      .values({
        issueId,
        verificationRunId: latestFailed?.id ?? null,
        userId,
        justification,
      })
      .returning();

    // Mark the verification_run as overridden so the gate treats it as passed
    if (latestFailed) {
      await db
        .update(verificationRuns)
        .set({ status: "overridden" })
        .where(eq(verificationRuns.id, latestFailed.id));
    }

    // Resolve any open escalations
    try {
      await resolveEscalation(db, issueId, "overridden");
    } catch {
      // best effort
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.verification_override",
      entityType: "issue",
      entityId: issue.id,
      details: {
        overrideId: override.id,
        verificationRunId: latestFailed?.id ?? null,
        justification,
        issueIdentifier: issue.identifier,
      },
    });

    res.json({
      overrideId: override.id,
      issueId,
      issueIdentifier: issue.identifier,
      verificationRunId: latestFailed?.id ?? null,
      createdAt: override.createdAt,
    });
  });

  /**
   * GET /api/companies/:companyId/verification-failures
   * Board-only. Returns currently-open verification escalations for a company. Powers the
   * /verification-failures dashboard.
   */
  router.get("/companies/:companyId/verification-failures", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const rows = await listOpenEscalations(db, companyId);
    res.json({ escalations: rows });
  });

  return router;
}

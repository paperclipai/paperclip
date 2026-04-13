import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  verificationRuns,
  issues,
  type NewVerificationRun,
  type VerificationRun,
  type VerificationRunContext,
} from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { runPlaywrightSpec, type RunPlaywrightResult } from "./runners/playwright-runner.js";
import { traceUploader, type TraceUploader } from "./trace-uploader.js";

export type DeliverableType =
  | "url"
  | "api"
  | "migration"
  | "cli"
  | "config"
  | "data"
  | "lib_frontend"
  | "lib_backend";

export interface RunSpecInput {
  issueId: string;
  deliverableType: DeliverableType;
  specPath: string;
  context?: VerificationRunContext;
  targetUrl?: string;
  targetSha?: string;
  createdByAgentId?: string | null;
}

export type RunSpecResult =
  | {
      status: "passed";
      verificationRunId: string;
      traceAssetId: string | null;
      durationMs: number;
      attempts: number;
    }
  | {
      status: "failed";
      verificationRunId: string;
      traceAssetId: string | null;
      failureSummary: string;
      durationMs: number;
      attempts: number;
    }
  | {
      status: "unavailable";
      unavailableReason: string;
      attempts: number;
    };

export interface VerificationWorkerOptions {
  retryBudget?: number;
  retryDelayMs?: number;
  runUrl?: typeof runPlaywrightSpec;
  uploader?: TraceUploader;
  sleep?: (ms: number) => Promise<void>;
}

export interface VerificationWorker {
  runSpec(input: RunSpecInput): Promise<RunSpecResult>;
}

/**
 * Orchestrates a verification run across retry attempts and persists one verification_runs row
 * per attempt. Delegates actual spec execution to type-specific runners (Phase 1 ships `url` only).
 */
export function createVerificationWorker(
  db: Db,
  storage: StorageService,
  options: VerificationWorkerOptions = {},
): VerificationWorker {
  const {
    retryBudget = 3,
    retryDelayMs = 60_000,
    runUrl = runPlaywrightSpec,
    uploader = traceUploader(db, storage),
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  async function loadIssueCompanyId(issueId: string): Promise<string> {
    const row = await db
      .select({ companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!row) throw new Error(`issue ${issueId} not found`);
    return row.companyId;
  }

  async function recordAttempt(
    input: RunSpecInput,
    attemptNumber: number,
  ): Promise<VerificationRun> {
    const values: NewVerificationRun = {
      issueId: input.issueId,
      deliverableType: input.deliverableType,
      specPath: input.specPath,
      context: input.context ?? null,
      targetSha: input.targetSha ?? null,
      status: "running",
      attemptNumber,
    };
    const [row] = await db.insert(verificationRuns).values(values).returning();
    return row;
  }

  async function finalizeAttempt(
    runId: string,
    patch: Partial<Omit<VerificationRun, "id" | "issueId">>,
  ): Promise<VerificationRun> {
    const [row] = await db
      .update(verificationRuns)
      .set({
        ...patch,
        completedAt: patch.completedAt ?? new Date(),
      })
      .where(eq(verificationRuns.id, runId))
      .returning();
    return row;
  }

  async function dispatchRunner(input: RunSpecInput): Promise<RunPlaywrightResult> {
    if (input.deliverableType !== "url") {
      return {
        status: "unavailable",
        unavailableReason: `deliverable_type ${input.deliverableType} not yet supported (Phase 1 only handles url)`,
      };
    }
    if (!input.targetUrl || !input.targetSha) {
      return {
        status: "unavailable",
        unavailableReason: "url deliverables require targetUrl and targetSha",
      };
    }
    return runUrl({
      issueId: input.issueId,
      specPath: input.specPath,
      context: input.context ?? "anonymous",
      targetSha: input.targetSha,
      targetUrl: input.targetUrl,
    });
  }

  return {
    async runSpec(input) {
      const companyId = await loadIssueCompanyId(input.issueId);
      let failedAttempts = 0; // counts confirmed fail/pass attempts against retryBudget
      let totalAttempts = 0; // counts every attempt (including unavailable) for safety ceiling
      const safetyCeiling = Math.max(retryBudget * 2, retryBudget + 3);
      let lastUnavailableReason: string | null = null;
      let lastFailureSummary: string | null = null;
      let lastFailureRunId: string | null = null;
      let lastFailureAssetId: string | null = null;
      let lastFailureDurationMs = 0;

      while (failedAttempts < retryBudget && totalAttempts < safetyCeiling) {
        totalAttempts += 1;
        const runRow = await recordAttempt(input, totalAttempts);
        const startedAt = Date.now();
        let runResult: RunPlaywrightResult;
        try {
          runResult = await dispatchRunner(input);
        } catch (err) {
          runResult = {
            status: "unavailable",
            unavailableReason: err instanceof Error ? err.message : String(err),
          };
        }

        if (runResult.status === "unavailable") {
          lastUnavailableReason = runResult.unavailableReason;
          await finalizeAttempt(runRow.id, {
            status: "unavailable",
            unavailableReason: runResult.unavailableReason,
            durationMs: Date.now() - startedAt,
          });
          // Unavailable attempts do NOT consume the retry budget, but DO consume the safety ceiling.
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          continue;
        }

        failedAttempts += 1;

        let traceAssetId: string | null = null;
        if (runResult.status === "passed" || runResult.status === "failed") {
          try {
            const upload = await uploader.upload({
              companyId,
              issueId: input.issueId,
              traceDir: runResult.traceDir,
              createdByAgentId: input.createdByAgentId ?? null,
            });
            traceAssetId = upload.assetId;
          } catch (err) {
            // Trace upload failure is logged but does not invalidate the result itself.
            console.warn(
              `[verification-worker] trace upload failed for issue ${input.issueId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        if (runResult.status === "passed") {
          const finalized = await finalizeAttempt(runRow.id, {
            status: "passed",
            traceAssetId,
            deployedSha: runResult.deployedSha,
            durationMs: runResult.durationMs,
          });
          return {
            status: "passed",
            verificationRunId: finalized.id,
            traceAssetId,
            durationMs: runResult.durationMs,
            attempts: totalAttempts,
          };
        }

        // failed
        lastFailureSummary = runResult.failureSummary;
        lastFailureRunId = runRow.id;
        lastFailureAssetId = traceAssetId;
        lastFailureDurationMs = runResult.durationMs;
        await finalizeAttempt(runRow.id, {
          status: "failed",
          failureSummary: runResult.failureSummary,
          traceAssetId,
          deployedSha: runResult.deployedSha,
          durationMs: runResult.durationMs,
        });
        if (failedAttempts < retryBudget && retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
      }

      if (lastFailureRunId && lastFailureSummary) {
        return {
          status: "failed",
          verificationRunId: lastFailureRunId,
          traceAssetId: lastFailureAssetId,
          failureSummary: lastFailureSummary,
          durationMs: lastFailureDurationMs,
          attempts: totalAttempts,
        };
      }

      return {
        status: "unavailable",
        unavailableReason:
          lastUnavailableReason ?? "retry budget exhausted without producing a definitive result",
        attempts: totalAttempts,
      };
    },
  };
}

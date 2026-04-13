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
import { runPlaywrightSpec } from "./runners/playwright-runner.js";
import { runApiSpec } from "./runners/api-runner.js";
import { runMigrationSpec } from "./runners/migration-runner.js";
import { runCliSpec } from "./runners/cli-runner.js";
import { runConfigSpec } from "./runners/config-runner.js";
import { runDataSpec } from "./runners/data-runner.js";
import { runVitestSpec } from "./runners/vitest-runner.js";
import { openEscalation, cancelOpenEscalationsForIssue } from "./escalation-sweeper.js";
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
  runApi?: typeof runApiSpec;
  runMigration?: typeof runMigrationSpec;
  runCli?: typeof runCliSpec;
  runConfig?: typeof runConfigSpec;
  runData?: typeof runDataSpec;
  runVitest?: typeof runVitestSpec;
  uploader?: TraceUploader;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Normalized dispatch result for all runner types. Each runner returns its own richer type, but
 * the worker only needs status + optional traceDir (url runner only) + durationMs + failure/unavailable
 * details. The `traceDir` is set only when the runner has a Playwright trace to upload.
 */
interface NormalizedRunResult {
  status: "passed" | "failed" | "unavailable";
  durationMs: number;
  traceDir?: string;
  deployedSha?: string;
  failureSummary?: string;
  unavailableReason?: string;
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
    runApi = runApiSpec,
    runMigration = runMigrationSpec,
    runCli = runCliSpec,
    runConfig = runConfigSpec,
    runData = runDataSpec,
    runVitest = runVitestSpec,
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

  async function dispatchRunner(input: RunSpecInput): Promise<NormalizedRunResult> {
    if (input.deliverableType === "url") {
      if (!input.targetUrl || !input.targetSha) {
        return {
          status: "unavailable",
          durationMs: 0,
          unavailableReason: "url deliverables require targetUrl and targetSha",
        };
      }
      const result = await runUrl({
        issueId: input.issueId,
        specPath: input.specPath,
        context: input.context ?? "anonymous",
        targetSha: input.targetSha,
        targetUrl: input.targetUrl,
      });
      if (result.status === "unavailable") {
        return {
          status: "unavailable",
          durationMs: 0,
          unavailableReason: result.unavailableReason,
        };
      }
      if (result.status === "passed") {
        return {
          status: "passed",
          durationMs: Math.floor(result.durationMs),
          traceDir: result.traceDir,
          deployedSha: result.deployedSha,
        };
      }
      return {
        status: "failed",
        durationMs: Math.floor(result.durationMs),
        traceDir: result.traceDir,
        deployedSha: result.deployedSha,
        failureSummary: result.failureSummary,
      };
    }

    if (input.deliverableType === "api") {
      const result = await runApi({ issueId: input.issueId, specPath: input.specPath });
      if (result.status === "unavailable") {
        return { status: "unavailable", durationMs: 0, unavailableReason: result.unavailableReason };
      }
      if (result.status === "passed") {
        return { status: "passed", durationMs: result.durationMs };
      }
      return { status: "failed", durationMs: result.durationMs, failureSummary: result.failureSummary };
    }

    if (input.deliverableType === "migration") {
      const result = await runMigration({ issueId: input.issueId, specPath: input.specPath, db });
      if (result.status === "unavailable") {
        return { status: "unavailable", durationMs: 0, unavailableReason: result.unavailableReason };
      }
      if (result.status === "passed") {
        return { status: "passed", durationMs: result.durationMs };
      }
      return { status: "failed", durationMs: result.durationMs, failureSummary: result.failureSummary };
    }

    if (input.deliverableType === "cli") {
      const result = await runCli({ issueId: input.issueId, specPath: input.specPath });
      if (result.status === "unavailable") {
        return { status: "unavailable", durationMs: 0, unavailableReason: result.unavailableReason };
      }
      if (result.status === "passed") {
        return { status: "passed", durationMs: result.durationMs };
      }
      return { status: "failed", durationMs: result.durationMs, failureSummary: result.failureSummary };
    }

    if (input.deliverableType === "config") {
      const result = await runConfig({ issueId: input.issueId, specPath: input.specPath });
      if (result.status === "unavailable") {
        return { status: "unavailable", durationMs: 0, unavailableReason: result.unavailableReason };
      }
      if (result.status === "passed") {
        return { status: "passed", durationMs: result.durationMs };
      }
      return { status: "failed", durationMs: result.durationMs, failureSummary: result.failureSummary };
    }

    if (input.deliverableType === "data") {
      const result = await runData({ issueId: input.issueId, specPath: input.specPath, db });
      if (result.status === "unavailable") {
        return { status: "unavailable", durationMs: 0, unavailableReason: result.unavailableReason };
      }
      if (result.status === "passed") {
        return { status: "passed", durationMs: result.durationMs };
      }
      return { status: "failed", durationMs: result.durationMs, failureSummary: result.failureSummary };
    }

    if (input.deliverableType === "lib_frontend" || input.deliverableType === "lib_backend") {
      const result = await runVitest({ issueId: input.issueId, specPath: input.specPath });
      if (result.status === "unavailable") {
        return { status: "unavailable", durationMs: 0, unavailableReason: result.unavailableReason };
      }
      if (result.status === "passed") {
        return { status: "passed", durationMs: result.durationMs };
      }
      return { status: "failed", durationMs: result.durationMs, failureSummary: result.failureSummary };
    }

    return {
      status: "unavailable",
      durationMs: 0,
      unavailableReason: `deliverable_type ${input.deliverableType} not yet supported by verification worker`,
    };
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
        let runResult: NormalizedRunResult;
        try {
          runResult = await dispatchRunner(input);
        } catch (err) {
          runResult = {
            status: "unavailable",
            durationMs: Math.floor(Date.now() - startedAt),
            unavailableReason: err instanceof Error ? err.message : String(err),
          };
        }

        if (runResult.status === "unavailable") {
          lastUnavailableReason = runResult.unavailableReason ?? "unknown";
          await finalizeAttempt(runRow.id, {
            status: "unavailable",
            unavailableReason: runResult.unavailableReason,
            durationMs: Math.floor(Date.now() - startedAt),
          });
          // Unavailable attempts do NOT consume the retry budget, but DO consume the safety ceiling.
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          continue;
        }

        failedAttempts += 1;

        let traceAssetId: string | null = null;
        // Trace upload only applies to runners that produced a traceDir (url runner).
        // API/migration runners have no trace artifact — the pass/fail verdict itself is the evidence.
        if (runResult.traceDir) {
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

        const durationMsInt = Math.floor(runResult.durationMs);

        if (runResult.status === "passed") {
          const finalized = await finalizeAttempt(runRow.id, {
            status: "passed",
            traceAssetId,
            deployedSha: runResult.deployedSha,
            durationMs: durationMsInt,
          });
          // Cancel any open escalations for this issue — a passing run resolves the ladder.
          try {
            await cancelOpenEscalationsForIssue(db, input.issueId);
          } catch (err) {
            console.warn(
              `[verification-worker] failed to cancel escalations for ${input.issueId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          return {
            status: "passed",
            verificationRunId: finalized.id,
            traceAssetId,
            durationMs: durationMsInt,
            attempts: totalAttempts,
          };
        }

        // failed
        lastFailureSummary = runResult.failureSummary ?? "unknown failure";
        lastFailureRunId = runRow.id;
        lastFailureAssetId = traceAssetId;
        lastFailureDurationMs = durationMsInt;
        await finalizeAttempt(runRow.id, {
          status: "failed",
          failureSummary: runResult.failureSummary,
          traceAssetId,
          deployedSha: runResult.deployedSha,
          durationMs: durationMsInt,
        });
        if (failedAttempts < retryBudget && retryDelayMs > 0) {
          await sleep(retryDelayMs);
        }
      }

      if (lastFailureRunId && lastFailureSummary) {
        // Retry budget exhausted with a definitive failure. Open an escalation so the sweeper
        // can advance the ladder and alert the assignee/manager/CEO/board over time.
        try {
          await openEscalation(db, {
            issueId: input.issueId,
            verificationRunId: lastFailureRunId,
          });
        } catch (err) {
          console.warn(
            `[verification-worker] failed to open escalation for ${input.issueId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
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

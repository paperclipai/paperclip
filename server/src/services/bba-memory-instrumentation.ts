/**
 * BBA Memory Instrumentation — wraps `bettingBrowserAutomationService` so
 * every `execute()` call is journaled to bba-memory without touching the
 * 2449-line service code.
 *
 * Architecture: decorator pattern. Pass the original service in, get a
 * structurally identical service out where `execute()` is now wrapped.
 *
 * Records:
 *   - One `runs` row per execute() call, source='manual', trigger=issue:<id>
 *   - failure_class derived from the structured result.status
 *   - meta_json with companyId, issueId, matchLabel(s), placedBetId
 *   - exceptions become recordFailure + completeRun(failure)
 *
 * Single-concurrent-execution assumption holds because BBA is single-threaded
 * by user choice, and we only set failureClass once per run.
 */
import {
  startRun,
  completeRun,
  recordFailure,
} from "./bba-memory/index.js";
import type { FailureClass, RunOutcome } from "./bba-memory/index.js";
import { classifyFailure } from "./bba-detector.js";
import { logger } from "../middleware/logger.js";

// Mirrors the result shape of bettingBrowserAutomationService().execute()
// without importing the full service module (avoids circular imports).
interface BbaResultLike {
  status: string;
  failureReason?: string | null;
  placedBetId?: string | number | null;
  sessionId?: string;
  artifactDir?: string;
  logPath?: string;
}

interface BbaRequestLike {
  companyId: string;
  issueId?: string | null;
  bet?: { matchLabel?: string; market?: string; selection?: string; stake?: number } | null;
  bets?: Array<{ matchLabel?: string; market?: string; selection?: string; stake?: number }>;
}

interface BettingService {
  execute: (request: any) => Promise<any>;
  [key: string]: unknown;
}

const STATUS_TO_OUTCOME: Record<string, RunOutcome> = {
  completed: "success",
  submitted_unconfirmed: "partial",
  awaiting_confirmation: "partial",
  failed: "failure",
  blocked_by_risk: "failure",
  session_expired: "failure",
};

const STATUS_TO_FAILURE_CLASS: Record<string, FailureClass | null> = {
  completed: null,
  submitted_unconfirmed: null,
  awaiting_confirmation: null,
  failed: "UNKNOWN",
  blocked_by_risk: "UNKNOWN",
  session_expired: "SESSION_NOT_DETECTED",
};

function summarizeBets(req: BbaRequestLike): string {
  if (req.bet) {
    return `${req.bet.matchLabel ?? "?"} | ${req.bet.market ?? "?"}/${req.bet.selection ?? "?"} | ${req.bet.stake ?? 0}`;
  }
  if (req.bets && req.bets.length > 0) {
    return req.bets
      .map((b) => `${b.matchLabel ?? "?"}/${b.selection ?? "?"}`)
      .join(" + ");
  }
  return "?";
}

export function instrumentBettingService<S extends BettingService>(svc: S): S {
  const originalExecute = svc.execute.bind(svc);

  const wrapped: BettingService = {
    ...svc,
    execute: async (request: any): Promise<any> => {
      const startedAt = Date.now();
      const runId = startRun({
        source: "manual",
        trigger: request.issueId ? `issue:${request.issueId}` : "api-direct",
        sessionStatusBefore: "unknown",
      });

      logger.info(
        { runId, issueId: request.issueId, bet: summarizeBets(request) },
        "bba-instrument: execute() started",
      );

      try {
        const result = await originalExecute(request);
        const outcome = STATUS_TO_OUTCOME[result.status] ?? "failure";
        const failureClass = result.status in STATUS_TO_FAILURE_CLASS ? STATUS_TO_FAILURE_CLASS[result.status] : "UNKNOWN";

        if (outcome === "failure" || outcome === "partial") {
          recordFailure({
            runId,
            failureClass: failureClass ?? "UNKNOWN",
            step: "other",
            errorMessage: result.failureReason ?? `status: ${result.status}`,
            screenshotPath: undefined,
            url: undefined,
            meta: { resultStatus: result.status, placedBetId: result.placedBetId },
          });
        }

        completeRun(runId, {
          outcome,
          failureClass: failureClass ?? undefined,
          sessionStatusAfter: result.status === "session_expired" ? "expired" : "active",
          durationMs: Date.now() - startedAt,
          notes: result.failureReason ?? undefined,
          meta: {
            resultStatus: result.status,
            placedBetId: result.placedBetId ?? null,
            sessionId: result.sessionId ?? null,
            artifactDir: result.artifactDir ?? null,
            companyId: request.companyId,
            issueId: request.issueId ?? null,
            betSummary: summarizeBets(request),
          },
        });

        logger.info(
          { runId, status: result.status, outcome, failureClass },
          "bba-instrument: execute() finished",
        );

        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failureClass = await classifyFailure({ errorMessage: errMsg });

        recordFailure({
          runId,
          failureClass,
          step: "other",
          errorMessage: errMsg,
          meta: { exception: true, companyId: request.companyId, issueId: request.issueId ?? null },
        });

        completeRun(runId, {
          outcome: "failure",
          failureClass,
          sessionStatusAfter: "unknown",
          durationMs: Date.now() - startedAt,
          notes: `exception: ${errMsg}`,
          meta: {
            exception: true,
            companyId: request.companyId,
            issueId: request.issueId ?? null,
            betSummary: summarizeBets(request),
          },
        });

        logger.warn(
          { runId, err, issueId: request.issueId },
          "bba-instrument: execute() threw",
        );
        throw err;
      }
    },
  };

  return wrapped as S;
}

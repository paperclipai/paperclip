import { buildCampaignAccounting } from "./attempt-accounting.js";
import { durationLabel, html } from "./report-format.js";
import { WORKER_TIMING_PHASES } from "./worker-timing.js";
import type { RunnerE2ECampaignAccounting, RunnerE2EResult } from "./types.js";

export const campaignTimingScope = "Attempt durations include setup and cleanup captured inside each attempt. The observed window spans the earliest retained start to the latest retained finish, including gaps and overlap. Carried-forward evidence can span older runs, so this window is not the current workflow's duration. Neither measure is CI queue/setup time or provider-billed runtime.";

export function summarizeCampaignTiming(
  results: readonly RunnerE2EResult[],
  retained?: RunnerE2ECampaignAccounting,
) {
  const accounting = retained ?? buildCampaignAccounting({ results });
  const attempts = accounting.attempts;
  const subtotal = attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
  const subtotalMs = Number.isFinite(subtotal) ? subtotal : null;
  const starts = attempts.map(attempt => Date.parse(attempt.startedAt));
  const finishes = attempts.map(attempt => Date.parse(attempt.finishedAt));
  const validWindows = attempts.length > 0 && starts.every((start, index) =>
    Number.isFinite(start) && Number.isFinite(finishes[index]) && finishes[index]! >= start);
  const observedWindowMs = validWindows ? Math.max(...finishes) - Math.min(...starts) : null;
  const complete = attempts.length > 0 && accounting.missingAttempts === 0 && subtotalMs !== null;
  return {
    retainedAttempts: attempts.length,
    missingAttempts: accounting.missingAttempts,
    subtotalMs,
    totalMs: complete ? subtotalMs : null,
    observedWindowMs,
  };
}

export function campaignAttemptTimeLabel(timing: ReturnType<typeof summarizeCampaignTiming>) {
  if (timing.totalMs !== null) return durationLabel(timing.totalMs);
  return timing.retainedAttempts > 0 && timing.subtotalMs !== null
    ? `Unknown (${durationLabel(timing.subtotalMs)} retained subtotal)`
    : "Unknown";
}

export function campaignTimingText(timing: ReturnType<typeof summarizeCampaignTiming>) {
  return [
    `Summed attempt time: ${campaignAttemptTimeLabel(timing)}; ${timing.retainedAttempts} retained attempts; ${timing.missingAttempts} missing attempts.`,
    `Observed attempt window: ${durationLabel(timing.observedWindowMs)}.`,
    campaignTimingScope,
  ];
}

export function summarizeWorkerPhaseTiming(results: readonly RunnerE2EResult[], retained?: RunnerE2ECampaignAccounting) {
  const accounting = retained ?? buildCampaignAccounting({ results });
  const receipts = accounting.attempts.map(attempt => attempt.workerTiming);
  const completeAttempts = receipts.filter(receipt => receipt?.status === "complete").length;
  const partialAttempts = receipts.filter(receipt => receipt?.status === "partial").length;
  const complete = receipts.length > 0 && completeAttempts === receipts.length && accounting.missingAttempts === 0;
  return {
    retainedAttempts: receipts.length, completeAttempts, partialAttempts, missingAttempts: accounting.missingAttempts,
    phases: WORKER_TIMING_PHASES.map(phase => {
      const segments = receipts.flatMap(receipt => receipt && receipt.status !== "unavailable"
        ? receipt.segments.filter(segment => segment.phase === phase && segment.finishedAt !== null) : []);
      const subtotalMs = segments.reduce((total, segment) => total + Date.parse(segment.finishedAt!) - Date.parse(segment.startedAt), 0);
      return { phase, totalMs: complete ? subtotalMs : null, subtotalMs, observedSegments: segments.length };
    }),
  };
}

export const workerTimingScope = "Worker phases cover the test callback through finalization before result publication. Browser/server startup, parent cleanup, CI queue/build time and provider-billed runtime are outside these measurements. An interrupted phase has no inferred end time.";

function workerPhaseLabel(phase: ReturnType<typeof summarizeWorkerPhaseTiming>["phases"][number]) {
  return phase.totalMs !== null ? durationLabel(phase.totalMs)
    : phase.observedSegments ? `Unknown (${durationLabel(phase.subtotalMs)} observed)` : "Unknown";
}

export function workerPhaseTimingText(timing: ReturnType<typeof summarizeWorkerPhaseTiming>) {
  return [
    `Worker phase coverage: ${timing.completeAttempts}/${timing.retainedAttempts} complete receipts; ${timing.partialAttempts} partial; ${timing.missingAttempts} missing attempts.`,
    ...timing.phases.map(phase => `Worker ${phase.phase} time: ${workerPhaseLabel(phase)}.`),
    workerTimingScope,
  ];
}

export function renderWorkerPhaseTiming(timing: ReturnType<typeof summarizeWorkerPhaseTiming>) {
  return `<section class="billing-overview" aria-label="Worker phase timing">
    ${timing.phases.map(phase => `<div class="billing-metric"><strong>${html(workerPhaseLabel(phase))}</strong><span>Worker ${phase.phase} time</span></div>`).join("")}
    <p class="billing-note">${timing.completeAttempts}/${timing.retainedAttempts} complete worker receipts; ${timing.partialAttempts} partial; ${timing.missingAttempts} missing attempts. ${html(workerTimingScope)}</p>
  </section>`;
}

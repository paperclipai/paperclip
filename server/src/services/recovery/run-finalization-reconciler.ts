import { isProcessAlive, outputSilenceAgeMs } from "./process-liveness.js";
import { resolveRunChildPid } from "./run-pid-file.js";

export const RUN_RECONCILER_ERROR_CODE = "run_reconciler";

export type RunFinalizationCandidate = {
  runId: string;
  status: string;
  processPid: number | null;
  lastOutputAt: Date | null;
  lastOutputSeq: number | null;
  processStartedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date | null;
  tracksLocalChild: boolean;
  hasInMemoryHandle: boolean;
};

export type RunFinalizationDecision = {
  finalize: boolean;
  reason: string;
  childPid: number | null;
  childPidAlive: boolean | null;
  outputSilenceAgeMs: number | null;
};

export function shouldFinalizeRunForReconciler(
  input: RunFinalizationCandidate & {
    now: Date;
    outputStagnantTtlMs: number;
    pidFileDir: string;
  },
): Promise<RunFinalizationDecision> {
  return evaluateRunFinalizationDecision(input);
}

async function evaluateRunFinalizationDecision(
  input: RunFinalizationCandidate & {
    now: Date;
    outputStagnantTtlMs: number;
    pidFileDir: string;
  },
): Promise<RunFinalizationDecision> {
  if (input.status !== "running") {
    return {
      finalize: false,
      reason: "run_not_running",
      childPid: null,
      childPidAlive: null,
      outputSilenceAgeMs: null,
    };
  }

  if (input.hasInMemoryHandle) {
    return {
      finalize: false,
      reason: "in_memory_handle_present",
      childPid: null,
      childPidAlive: null,
      outputSilenceAgeMs: null,
    };
  }

  const silenceAgeMs = outputSilenceAgeMs(input, input.now);
  const outputStagnant =
    silenceAgeMs !== null && silenceAgeMs >= input.outputStagnantTtlMs;

  let childPid: number | null = null;
  let childPidAlive: boolean | null = null;
  if (input.tracksLocalChild) {
    childPid = await resolveRunChildPid({
      pidFileDir: input.pidFileDir,
      runId: input.runId,
      processPid: input.processPid,
    });
    childPidAlive = childPid ? isProcessAlive(childPid) : false;
  }

  if (input.tracksLocalChild) {
    if (childPidAlive === false) {
      return {
        finalize: true,
        reason: "child_pid_not_alive",
        childPid,
        childPidAlive,
        outputSilenceAgeMs: silenceAgeMs,
      };
    }
    if (outputStagnant) {
      return {
        finalize: true,
        reason: "output_stagnant_beyond_ttl",
        childPid,
        childPidAlive,
        outputSilenceAgeMs: silenceAgeMs,
      };
    }
    return {
      finalize: false,
      reason: "child_alive_and_output_recent",
      childPid,
      childPidAlive,
      outputSilenceAgeMs: silenceAgeMs,
    };
  }

  if (outputStagnant) {
    return {
      finalize: true,
      reason: "output_stagnant_beyond_ttl",
      childPid,
      childPidAlive,
      outputSilenceAgeMs: silenceAgeMs,
    };
  }

  return {
    finalize: false,
    reason: "output_recent",
    childPid,
    childPidAlive,
    outputSilenceAgeMs: silenceAgeMs,
  };
}

export function buildRunReconcilerSystemComment(input: {
  runId: string;
  reason: string;
  childPid: number | null;
  outputSilenceAgeMs: number | null;
  signal?: "reconciler" | "sigterm";
}) {
  const signalLabel =
    input.signal === "sigterm"
      ? "Paperclip received SIGTERM and finalized this run to release the checkout lock."
      : "The run-finalization reconciler finalized this run to release a leaked checkout lock.";
  const detailParts = [
    `- Run: \`${input.runId}\``,
    `- Reason: \`${input.reason}\``,
  ];
  if (input.childPid) {
    detailParts.push(`- Child PID: \`${input.childPid}\``);
  }
  if (input.outputSilenceAgeMs !== null) {
    detailParts.push(`- Output silence age: \`${Math.round(input.outputSilenceAgeMs / 1000)}s\``);
  }
  return [
    signalLabel,
    "The issue was returned to `todo` for a clean retry. This is terminal finalization — no automatic re-wake was queued.",
    "",
    ...detailParts,
  ].join("\n");
}

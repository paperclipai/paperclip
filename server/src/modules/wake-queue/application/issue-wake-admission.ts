import type { RunSummary } from "./types.js";

export type IssueWakeAdmissionOutcome<Run> =
  | { kind: "queued" | "coalesced" | "replayed"; run: Run }
  | { kind: "durable"; receipt: { runId: string | null } }
  | { kind: "deferred"; admitted?: boolean }
  | { kind: "skipped" };

export type IssueWakeAdmissionEffects<Run> = {
  saved?(): void;
  publishIssueActivity(): void;
  executeIssueActions(): Promise<void>;
  cancelledRuns: readonly Run[];
  emitCancelledRun(run: Run): Promise<unknown>;
  readRun(runId: string): Promise<Run | null>;
  publishQueuedRun(run: RunSummary): void;
  attachSetupRequest(): Promise<unknown>;
  dispatch(): Promise<unknown>;
};

/** Hand off only a committed admission. A contended authorization rolls back. */
export async function admitIssueWake<Run extends RunSummary & { status: string }>(
  commit: () => Promise<IssueWakeAdmissionOutcome<Run> | null>,
  effects: IssueWakeAdmissionEffects<Run>,
): Promise<Run | null> {
  const outcome = await commit();
  if (!outcome) return null;

  if (outcome.kind !== "deferred" && outcome.kind !== "skipped") effects.saved?.();
  effects.publishIssueActivity();
  await effects.executeIssueActions();

  // Cancellation telemetry does not gate dispatch or the admission result.
  for (const run of effects.cancelledRuns) void effects.emitCancelledRun(run);

  if (outcome.kind === "durable") {
    return outcome.receipt.runId ? effects.readRun(outcome.receipt.runId) : null;
  }
  if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;

  if (outcome.kind === "queued") effects.publishQueuedRun(outcome.run);
  if (outcome.kind !== "replayed" || outcome.run.status === "queued") {
    await effects.attachSetupRequest();
    await effects.dispatch();
  }
  return outcome.run;
}

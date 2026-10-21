import type { ContinuationCheckpoint } from "./continuation-scoring.js";
export interface LifecycleSnapshot {
  executionRunId: string | null;
  scheduledRetry: unknown;
  activeRecoveryAction: unknown;
  monitorNextCheckAt: string | null;
}
export type LifecycleCheckpoint = ContinuationCheckpoint & {
  lifecycle?: LifecycleSnapshot;
  // Successful persisted mutations; not a count of failed tool/HTTP attempts.
  activity?: unknown[];
};
type Interaction = {
  id?: string;
  kind?: string;
  status?: string;
  sourceRunId?: string;
  payload?: {
    runtimeRequestId?: string;
    target?: {
      type?: string;
      issueId?: string;
      key?: string;
      revisionId?: string;
    };
  };
};
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Semantic questions yield the run; provider-native questions instead pause
 * inside it. Only a pending runtime request bound to that running native run
 * permits retaining its execution lock at a waiting checkpoint. */
function hasHealthyWait(checkpoint: LifecycleCheckpoint, pending: Interaction[]) {
  const state = checkpoint.lifecycle;
  if (!state || state.scheduledRetry !== null || state.activeRecoveryAction !== null ||
      state.monitorNextCheckAt !== null || checkpoint.runs.length === 0) return false;
  const active = checkpoint.runs.filter(run => run.status !== "succeeded");
  if (active.length === 0)
    return checkpoint.issue.status === "in_review" && state.executionRunId === null;
  if (active.length !== 1) return false;
  const run = active[0];
  return run.status === "running" && run.runtimeMode === "native" && nonempty(run.id) &&
    state.executionRunId === run.id && ["in_progress", "in_review"].includes(checkpoint.issue.status) &&
    pending.some(interaction => interaction.kind === "ask_user_questions" &&
      nonempty(interaction.id) && interaction.sourceRunId === run.id &&
      nonempty(interaction.payload?.runtimeRequestId));
}

/** Independent durable-state oracle. It never interprets response prose. */
export function gradeLifecycleBaseline(checkpoints: LifecycleCheckpoint[]) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) =>
    checks.push({ id, passed, detail });
  const final = checkpoints.find((c) => c.phase === "final");
  const waiting = checkpoints.filter((c) => c.phase !== "final");
  check(
    "lifecycle.evidence-present",
    !!final?.lifecycle &&
      waiting.length > 0 &&
      waiting.every((c) => !!c.lifecycle),
    "Every checkpoint must retain lifecycle evidence from the public task API.",
  );
  const first = waiting[0];
  check(
    "lifecycle.task-owner-preserved",
    nonempty(first?.issue.id) && nonempty(first?.issue.assigneeAgentId) &&
      checkpoints.every(c => c.issue.id === first.issue.id &&
        c.issue.assigneeAgentId === first.issue.assigneeAgentId),
    "Waiting and resuming retain the same task and assigned agent.",
  );
  for (const c of waiting) {
    const pending = (c.interactions as Interaction[]).filter(
      (i) => i.status === "pending",
    );
    check(
      `lifecycle.${c.phase}.durable-wait`,
      pending.some(
        (i) =>
          nonempty(i.id) &&
          [
            "ask_user_questions",
            "request_confirmation",
            "request_approval",
          ].includes(i.kind ?? ""),
      ),
      "Waiting must have an identifiable pending interaction, not only an assistant message.",
    );
    check(
      `lifecycle.${c.phase}.wait-state`,
      hasHealthyWait(c, pending),
      "A settled wait is in_review with no execution lock, retry, recovery or monitor. A bound native provider question may keep its paused run and lock.",
    );
    for (const i of pending.filter(
      (i) => i.payload?.target?.type === "issue_document",
    )) {
      const target = i.payload!.target!;
      check(
        `lifecycle.${c.phase}.revision:${i.id}`,
        target.issueId === c.issue.id &&
          c.documents.some(
            (d) =>
              d.key === target.key &&
              typeof d.latestRevisionId === "string" &&
              d.latestRevisionId === target.revisionId,
          ),
        "Plan confirmation binds this task and the recorded current revision.",
      );
    }
  }
  check(
    "lifecycle.final.no-active-path",
    !!final?.lifecycle &&
      final.issue.status === "done" &&
      final.lifecycle.executionRunId === null &&
      final.lifecycle.scheduledRetry === null &&
      final.lifecycle.activeRecoveryAction === null &&
      final.lifecycle.monitorNextCheckAt === null &&
      final.runs.length > 0 &&
      final.runs.every((r) => !["queued", "running"].includes(r.status)),
    "Completed work has no live run, execution lock, scheduled retry, recovery or monitor.",
  );
  check(
    "lifecycle.final.no-pending-interaction",
    !!final &&
      !(final.interactions as Interaction[]).some(
        (i) => i.status === "pending",
      ),
    "Completion has no unresolved interaction.",
  );
  if (first && final) {
    const questions = new Map(waiting.flatMap(c =>
      (c.interactions as Interaction[]).filter(i => i.kind === "ask_user_questions" && i.status === "pending")
        .map(i => [i.id, i] as const)));
    for (const question of questions.values()) {
      const answers = (final.interactions as Interaction[]).filter(i => i.id === question.id);
      check(
        `lifecycle.answer:${question.id}`,
        nonempty(question.id) && answers.length === 1 &&
          answers[0].kind === "ask_user_questions" && answers[0].status === "answered",
        "Every observed pending question retains exactly one answered identity, including later questions.",
      );
    }
    const finalIds = new Set(final.runs.map(r => r.id));
    check(
      "lifecycle.final.preserved-runs",
      checkpoints.every(c => c.runs.length > 0 && c.runs.every(r => nonempty(r.id)) &&
        new Set(c.runs.map(r => r.id)).size === c.runs.length) &&
        waiting.every(c => c.runs.every(r => finalIds.has(r.id))),
      "All intermediate run receipts survive in the final snapshot without duplicated or empty IDs.",
    );
  }
  return checks;
}

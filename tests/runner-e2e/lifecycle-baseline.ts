import type { ContinuationCheckpoint } from "./continuation-scoring.js";
export interface LifecycleSnapshot {
  executionRunId: string | null;
  scheduledRetry: unknown;
  activeRecoveryAction: unknown;
  monitorNextCheckAt: string | null;
}
export type LifecycleCheckpoint = ContinuationCheckpoint & {
  lifecycle?: LifecycleSnapshot;
};
type Interaction = {
  id?: string;
  kind?: string;
  status?: string;
  sourceRunId?: string;
  payload?: {
    target?: {
      type?: string;
      issueId?: string;
      key?: string;
      revisionId?: string;
    };
  };
};
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
  for (const c of waiting) {
    const pending = (c.interactions as Interaction[]).filter(
      (i) => i.status === "pending",
    );
    check(
      `lifecycle.${c.phase}.durable-wait`,
      pending.some(
        (i) =>
          typeof i.id === "string" &&
          [
            "ask_user_questions",
            "request_confirmation",
            "request_approval",
          ].includes(i.kind ?? ""),
      ),
      "Waiting must have an identifiable pending interaction, not only an assistant message.",
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
  const first = waiting[0];
  if (first && final) {
    for (const question of (first.interactions as Interaction[]).filter(
      (i) => i.kind === "ask_user_questions" && i.status === "pending",
    )) {
      check(
        `lifecycle.answer:${question.id}`,
        typeof question.id === "string" &&
          (final.interactions as Interaction[]).some(
            (i) => i.id === question.id && i.status === "answered",
          ),
        "The original question identity has a durable answer.",
      );
    }
    const originalIds = new Set(first.runs.map((r) => r.id));
    check(
      "lifecycle.final.preserved-runs",
      first.runs.length > 0 &&
        [...originalIds].every((id) => final.runs.some((r) => r.id === id)) &&
        new Set(final.runs.map((r) => r.id)).size === final.runs.length,
      "Original run receipts remain present without duplicated IDs.",
    );
  }
  return checks;
}

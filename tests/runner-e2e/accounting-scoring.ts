import { accountingCommentBodies, type AccountingCase } from "./accounting-cases.js";
type Row = Record<string, any>;
export interface AccountingCheckpoint {
  phase: string; issue: Row; runs: Row[]; comments: Row[]; interactions: Row[]; documents: Row[];
}
export function gradeAccounting(input: { probe: AccountingCase; nonce: string; agentId: string; runtime: string; checkpoints: AccountingCheckpoint[] }) {
  const { probe, checkpoints, nonce, agentId } = input;
  const final = checkpoints.find(c => c.phase === "final");
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: unknown, detail: string) => checks.push({ id, passed: !!passed, detail });
  check("evidence", final && Array.isArray(final.runs) && final.runs.length > 0, "A final persisted checkpoint is required.");
  if (!final) return checks;
  const runs = final.runs;
  check("runtime", runs.every(r => r.runtimeMode === input.runtime), "Every run uses the selected runtime.");
  const executed = runs.filter(r => r.status === "succeeded");
  const bodies = accountingCommentBodies(probe, nonce);
  check("perturbation", executed.length > 0 && executed.every(r => bodies.every(body => final.comments.filter(c => c.body === body && c.authorAgentId === agentId && c.createdByRunId === r.id).length === 1)), "Each successful provider run actually posted all distinct prescribed attributed comments.");
  check("settled", ["executionRunId", "scheduledRetry", "monitorNextCheckAt", "activeRecoveryAction"].every(key => Object.hasOwn(final.issue, key)) && !final.issue.executionRunId && !final.issue.scheduledRetry && !final.issue.monitorNextCheckAt && !final.interactions.some(i => i.status === "pending"), "No live execution, retry, monitor, or pending interaction remains.");
  if (probe.kind === "productive") {
    check("productive-allowance", runs.length === 5 && executed.length === 5 && runs.every(r => !r.scheduledRetryAttempt && !r.contextSnapshot?.dispositionRepairAttempt && !r.contextSnapshot?.legacyDispositionEpisode), "Five successful productive runs consume no repair or infrastructure retries.");
    check("completed", final.issue.status === "done" && !final.issue.activeRecoveryAction, "Work finishes without recovery escalation.");
    for (let step = 1; step <= 5; step++) {
      const c = checkpoints.find(c => c.phase === `step-${step}`);
      const docs = c?.documents ?? [];
      check(`step-${step}`, c && c.runs.length === step && docs.length === step && Array.from({ length: step }, (_, n) => n + 1).every(n => docs.some(d => d.key === `step-${n}` && d.latestRevisionNumber === 1 && d.body === `STEP ${n}: ${n === 1 ? "START" : `VALUE${nonce}N${n}`}`)), "Each checkpoint contains exactly its completed records; no replay or premature later step.");
      if (step < 5) check(`wait-${step}`, c && c.interactions.filter(i => i.status === "pending" && i.kind === "ask_user_questions").length === 1 && !c.issue.scheduledRetry && !c.issue.activeRecoveryAction, "A real question owns the continuation, with no competing retry/repair.");
    }
    check("responses", final.interactions.length === 4 && final.interactions.every(i => i.kind === "ask_user_questions" && i.status === "answered"), "Four persisted question responses, each used once.");
  } else {
    const [source, first, second] = runs;
    const episode = (r?: Row) => r?.contextSnapshot?.legacyDispositionEpisode;
    check("first-repair", source?.status === "succeeded" && first?.status === "succeeded" && first?.contextSnapshot?.wakeReason === "issue_disposition_repair" && episode(first)?.id === source?.id && episode(first)?.attempt === 1 && episode(first)?.maxAttempts === 2, "One repair is causally bound to the original missing disposition.");
    if (probe.kind === "approval") {
      const waiting = checkpoints.find(c => c.phase === "approval");
      check("approval-owner", waiting && waiting.runs.length === 2 && waiting.interactions.filter(i => i.kind === "request_confirmation" && i.status === "pending").length === 1 && !waiting.issue.scheduledRetry, "Pending approval owns the wait; no second repair is queued.");
      check("approval-resumed", runs.length === 3 && executed.length === 3 && final.interactions.length === 1 && final.interactions[0].status === "accepted" && !episode(second) && final.issue.status === "done" && !final.issue.activeRecoveryAction, "One real approval causes one productive completion without inheriting repair debt.");
    } else {
      check("second-repair", runs.length === 3 && episode(second)?.id === source?.id && episode(second)?.attempt === 2 && episode(second)?.maxAttempts === 2, "The same episode permits exactly two repairs.");
      check("no-user-restart", !final.comments.some(c => c.authorUserId), "No user message silently grants a new episode.");
      if (probe.kind === "exhaustion") check("exhausted", executed.length === 3 && final.issue.status === "blocked" && final.issue.activeRecoveryAction?.ownerType === "board" && final.issue.activeRecoveryAction?.attemptCount === 2, "Exhaustion is visible and retains the consumed allowance.");
      else check("stopped", second?.status === "cancelled" && !second?.startedAt && checkpoints.some(c => c.phase === "scheduled") && checkpoints.some(c => c.phase === "after-due"), "Stop cancels the delayed second repair before provider dispatch and remains effective past its due time.");
      const delayed = checkpoints.find(c => c.phase === "scheduled");
      const resumed = checkpoints.find(c => c.phase === "restarted");
      check("restart", delayed && resumed && JSON.stringify(delayed.runs.map(r => [r.id, r.contextSnapshot?.legacyDispositionEpisode])) === JSON.stringify(resumed.runs.map(r => [r.id, r.contextSnapshot?.legacyDispositionEpisode])), "Controller restart preserves the exact run receipts and repair allowance.");
    }
  }
  return checks;
}

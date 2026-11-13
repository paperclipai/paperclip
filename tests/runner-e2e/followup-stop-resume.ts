import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export const STOP_QUIET_WINDOW_MS = 5000;
export function followupStopFiles(nonce: string) {
  return { context: `retained-context-${nonce}.txt`, checkpoint: `context-checkpoint-${nonce}.json`, result: `resumed-result-${nonce}.json`,
    initialLabel: `COBALT${nonce}`, finalLabel: `AMBER${nonce}` };
}
export const followupStopTask: RunnerTaskFixture = {
  id: "followup-stop-resume", label: "Follow-up during work, Stop, and resume retained context", groups: [], flow: "followup_stop_resume",
  workMode: "standard", expectedRunCount: 2, automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 12 * 60_000, daytona: 15 * 60_000 }, turnTimeoutMs: 5 * 60_000,
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Retain my working context ${nonce}`,
  buildVisibleMarker: nonce => followupStopFiles(nonce).result,
  buildPrompt(nonce) {
    const f = followupStopFiles(nonce);
    return [
      `Read ${f.context} from the configured workspace. Preserve its exact bytes. The initial label is ${f.initialLabel}.`,
      `Save ${f.checkpoint} as JSON with exactly sourceSha256 (the SHA-256 of the complete context file) and label (the initial label). Register it as an artifact work product with that exact title.`,
      "Then run a real foreground shell command that waits 120 seconds. This represents ongoing work I may interrupt. Do not replace this command with a monitor, question, or completion report.",
      `After that command, write ${f.result} as JSON with exactly reference (the context file's text with trailing newline removed) and label (my latest requested label). Register it as a downloadable artifact work product with that exact title, deliver its link here, and finish.`,
      "A later Stop is authoritative. After an explicit resume, keep the original context file and apply my most recent earlier follow-up. Do not create other tasks or agents.",
    ].join("\n");
  }, buildMatchers: () => [],
};
export function stopRunBelongsToTask(run: { companyId?: unknown; agentId?: unknown; issueId?: unknown; nativeIssueId?: unknown;
  contextSnapshot?: { issueId?: unknown } | null }, binding: { companyId: string; agentId: string; issueId: string }) {
  const ids = [run.issueId, run.nativeIssueId, run.contextSnapshot?.issueId].filter(id => id !== null && id !== undefined);
  return run.companyId === binding.companyId && run.agentId === binding.agentId && ids.length > 0 && ids.every(id => id === binding.issueId);
}
export function isActiveStopCheckpointRun(run: { id?: string; status?: string } | undefined,
  events: readonly { runId?: string; eventType?: string; sourceKind?: string }[]) {
  if (!run?.id || run.status !== "running") return false;
  const owned = events.filter(event => event.runId === run.id);
  return owned.filter(event => event.eventType === "turn.started" && event.sourceKind === "runner").length === 1 &&
    !owned.some(event => ["run.result.accepted", "run.terminal", "turn.completed", "turn.failed", "turn.cancelled"].includes(event.eventType ?? ""));
}
export function exactSyntheticJson(content: string, expected: Record<string, string>): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const value = parsed as Record<string, unknown>;
  return Object.keys(value).sort().join(",") === Object.keys(expected).sort().join(",") &&
    Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}
export interface FollowupStopObservation {
  binding: { companyId: string; issueId: string; agentId: string };
  initial: { runId: string; workspaceId: string; instructionsDigest: string; toolFingerprint: string; checkpointVerified: boolean } | null;
  followup: { commentIds: string[]; runId: string; runStatus: string; acceptedResults: number; providerStarted: boolean; observedAt: string } | null;
  stop: { runId: string; status: string; acknowledgementMatches: boolean;
    samples: Array<{ at: string; runIds: string[]; automaticPath: boolean }>; resumeSubmittedAt: string | null } | null;
  final: { runIds: string[]; resumedRunId: string; workspaceId: string; sourceUnchanged: boolean; resultVerified: boolean;
    issueDone: boolean; resumeCommentBound: boolean; originalStillCancelled: boolean; committed: boolean; startedAt: string; instructionsDigest: string; toolFingerprint: string;
    finalDeliveryCount: number; deliveryReceiptMatches: boolean; visibleDelivery: boolean; pendingInteractions: number } | null;
}
export function gradeFollowupStopResume(value: FollowupStopObservation) {
  const { initial, followup, stop, final } = value;
  const check = (id: string, passed: unknown, detail: string) => ({ id, passed: Boolean(passed), detail });
  const first = stop?.samples[0], last = stop?.samples.at(-1), resumeAt = Date.parse(stop?.resumeSubmittedAt ?? "");
  return [
    check("active-followup-before-stop", initial?.checkpointVerified && followup?.commentIds.length === 1 &&
      followup.runId === initial.runId && followup.runStatus === "running" && followup.acceptedResults === 0 && followup.providerStarted &&
      Number.isFinite(Date.parse(followup.observedAt)) && first && Date.parse(followup.observedAt) <= Date.parse(first.at),
      "One ordinary user follow-up must persist while the original result-free provider run is still active."),
    check("stop-remains-authoritative", initial && stop?.runId === initial.runId && stop.status === "cancelled" && stop.acknowledgementMatches &&
      stop.samples.length >= 3 && first && last && Date.parse(last.at) - Date.parse(first.at) >= STOP_QUIET_WINDOW_MS &&
      stop.samples.every((sample, index) => Number.isFinite(Date.parse(sample.at)) && (index === 0 || Date.parse(sample.at) >= Date.parse(stop.samples[index - 1]!.at)) && sample.runIds.length === 1 && sample.runIds[0] === initial.runId && !sample.automaticPath) &&
      Number.isFinite(resumeAt) && Date.parse(last.at) <= resumeAt,
      "The acknowledged Stop must retain one cancelled run with no automatic continuation throughout the recorded quiet window before a real user resumes."),
    check("one-explicit-resumption", initial && final?.runIds.length === 2 && new Set(final.runIds).size === 2 &&
      final.runIds.includes(initial.runId) && final.runIds.includes(final.resumedRunId) && final.resumedRunId !== initial.runId &&
      final.originalStillCancelled && final.resumeCommentBound && final.committed && final.issueDone && Number.isFinite(resumeAt) && Date.parse(final.startedAt) >= resumeAt,
      "Only one user-triggered successor may complete the original task after Stop."),
    check("retained-context-workspace-tools", initial && final && !!initial.workspaceId && final.workspaceId === initial.workspaceId &&
      final.sourceUnchanged && final.resultVerified && /^[a-f0-9]{64}$/.test(initial.instructionsDigest) &&
      final.instructionsDigest === initial.instructionsDigest && /^sha256:[a-f0-9]{64}$/.test(initial.toolFingerprint) && final.toolFingerprint === initial.toolFingerprint,
      "The independently seeded context, earlier follow-up, workspace, production instructions and tool contract must survive without being restated in the resume message."),
    check("accessible-resumed-result", final?.finalDeliveryCount === 1 && final.deliveryReceiptMatches && final.visibleDelivery && final.pendingInteractions === 0,
      "One receipt-bound final reply must expose the independently verified result without a pending question."),
  ];
}
export function followupStopDigest() {
  const hash = createHash("sha256");
  for (const file of ["followup-stop-resume.ts", "followup-stop-resume-flow.ts", "run-delivery.ts", "followup-stop-evidence.ts", "task-text-artifact-download.ts", "api.ts", "user-actions.ts", "registered-artifact.ts", "stock-harness.ts", "runner.spec.ts"])
    hash.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return hash.digest("hex");
}

import { describe, expect, it } from "vitest";
import { admitIssueWake, createIssueWakePreflight, type IssueWakeAdmissionEffects, type IssueWakeAdmissionOutcome } from "./issue-wake-admission.js";

const queuedRun = { id: "run", companyId: "company", agentId: "agent", status: "queued",
  invocationSource: "assignment", triggerDetail: null, wakeupRequestId: "wake" };
type Run = typeof queuedRun;
const runningRun = { ...queuedRun, status: "running" };

function recordEffects(trace: string[]): IssueWakeAdmissionEffects<Run> {
  return {
    saved: () => { trace.push("saved"); },
    publishIssueActivity: () => { trace.push("issue activity"); },
    executeIssueActions: async () => { trace.push("issue actions"); },
    cancelledRuns: [{ ...queuedRun, status: "cancelled" }],
    emitCancelledRun: (run) => {
      trace.push(run.status);
      return new Promise(() => {});
    },
    readRun: async (runId) => { trace.push(`read ${runId}`); return runningRun; },
    publishQueuedRun: () => { trace.push("queued event"); },
    attachSetupRequest: async () => { trace.push("attach setup"); },
    dispatch: async () => { trace.push("dispatch"); },
  };
}

describe("issue wake preflight", () => {
  const input = {
    companyId: "company",
    issueId: "issue",
    agentId: "agent",
    reason: null,
    wakeReason: null,
    taskRetryActorId: null,
    hasIndependentConversationWakeCause: false,
  };
  const activeConversation = {
    conversationAgentId: "agent",
    conversationUserId: "owner",
    conversationState: "active",
    status: "in_progress",
    originKind: null,
  };
  const onboardingTask = {
    ...activeConversation,
    conversationAgentId: null,
    conversationUserId: null,
    conversationState: null,
    originKind: "onboarding_first_task",
  };

  it.each([
    { label: "onboarding completion", issue: onboardingTask, reasons: { reason: "issue_children_completed" },
      result: { kind: "eligible", onboardingCompletion: true } },
    { label: "onboarding context fallback", issue: onboardingTask, reasons: { wakeReason: "issue_children_completed" },
      result: { kind: "eligible", onboardingCompletion: false } },
    { label: "execution context fallback", issue: activeConversation, reasons: { wakeReason: "issue_children_completed" },
      result: { kind: "skipped" } },
    { label: "explicit reason over execution context", issue: activeConversation,
      reasons: { reason: "issue_commented", wakeReason: "issue_children_completed" },
      result: { kind: "eligible", onboardingCompletion: false } },
  ])("handles $label", async ({ issue, reasons, result }) => {
    const preflight = createIssueWakePreflight(async () => issue);
    await expect(preflight({ ...input, ...reasons })).resolves.toEqual(result);
  });

  it("requires the owner of a conversation for a manual start or retry", async () => {
    const preflight = createIssueWakePreflight(async () => activeConversation);
    await expect(preflight({ ...input, manualUserWake: true, requestedByActorId: "someone-else" }))
      .resolves.toEqual({ kind: "conversation_owner_required", action: "start" });
    await expect(preflight({ ...input, taskRetryActorId: "someone-else", reason: "issue_children_completed" }))
      .resolves.toEqual({ kind: "conversation_owner_required", action: "retry" });
  });
});

describe("issue wake admission handoff", () => {
  it("waits for commit before publishing or dispatching and leaves telemetry in the background", async () => {
    const trace: string[] = [];
    let commit!: (outcome: IssueWakeAdmissionOutcome<Run>) => void;
    const transaction = new Promise<IssueWakeAdmissionOutcome<Run>>((resolve) => { commit = resolve; });
    const result = admitIssueWake(() => transaction, recordEffects(trace));
    expect(trace).toEqual([]);

    commit({ kind: "queued", run: queuedRun });
    await expect(result).resolves.toBe(queuedRun);
    expect(trace).toEqual(["saved", "issue activity", "issue actions", "cancelled", "queued event", "attach setup", "dispatch"]);
  });

  it.each<{ outcome: IssueWakeAdmissionOutcome<Run>; returned: Run | null; handoff: string[] }>([
    { outcome: { kind: "coalesced", run: runningRun }, returned: runningRun, handoff: ["attach setup", "dispatch"] },
    { outcome: { kind: "replayed", run: queuedRun }, returned: queuedRun, handoff: ["attach setup", "dispatch"] },
    { outcome: { kind: "replayed", run: runningRun }, returned: runningRun, handoff: [] },
    { outcome: { kind: "durable", receipt: { runId: "run" } }, returned: runningRun, handoff: ["read run"] },
    { outcome: { kind: "durable", receipt: { runId: null } }, returned: null, handoff: [] },
    { outcome: { kind: "deferred", admitted: true }, returned: null, handoff: [] },
    { outcome: { kind: "skipped" }, returned: null, handoff: [] },
  ])("hands off $outcome.kind with the persisted run or receipt", async ({ outcome, returned, handoff }) => {
    const trace: string[] = [];
    await expect(admitIssueWake(async () => outcome, recordEffects(trace))).resolves.toBe(returned);
    const saved = outcome.kind === "deferred" || outcome.kind === "skipped" ? [] : ["saved"];
    expect(trace).toEqual([...saved, "issue activity", "issue actions", "cancelled", ...handoff]);
  });

  it("discards all buffered work when commit rejects", async () => {
    const trace: string[] = [];
    const error = new Error("commit failed");
    await expect(admitIssueWake(() => Promise.reject(error), recordEffects(trace))).rejects.toBe(error);
    expect(trace).toEqual([]);
  });

  it("surfaces post-commit failures even when they look like authorization contention", async () => {
    const trace: string[] = [];
    const effects = recordEffects(trace);
    const error = Object.assign(new Error("post-commit failure"), { code: "55P03" });
    effects.executeIssueActions = async () => { throw error; };
    await expect(admitIssueWake(async () => ({ kind: "queued", run: queuedRun }), effects)).rejects.toBe(error);
    expect(trace).toEqual(["saved", "issue activity"]);
  });
});

import { describe, expect, it } from "vitest";
import { admitIssueWake, type IssueWakeAdmissionEffects, type IssueWakeAdmissionOutcome } from "./issue-wake-admission.js";

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

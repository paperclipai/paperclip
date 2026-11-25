import { afterEach, expect, it, vi } from "vitest";
import { agentTaskSettled, validateAgentTaskState, waitFor } from "./agent-flows.js";
import type { JourneyContext } from "./types.js";

type Row = Record<string, any>;
const context = { company: { id: "company" }, environmentId: "environment",
  agent: { id: "agent", provider: "opencode", model: "model", runtimeMode: "native" } } as JourneyContext;
function snapshot() {
  const now = Date.now();
  const run: Row & { status: string } = { id: "run", companyId: "company", agentId: "agent", issueId: "task", nativeIssueId: "task",
    runtimeMode: "native", status: "failed", nativePhase: "retryable_failure", errorCode: "native_session_interrupted",
    finishedAt: new Date(now - 1_000).toISOString(), contextSnapshot: { issueId: "task", paperclipEnvironment: { id: "environment" } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "model" } } },
    execution: { phase: "retry_scheduled", cause: "native_session_interrupted", attempt: 1, maxAttempts: 3,
      recoveryOwner: "agent", retryAt: new Date(now + 1_000).toISOString() } };
  return { currentIssue: { id: "task", companyId: "company", assigneeAgentId: "agent", status: "in_progress" },
    taskRuns: [run], comments: [], interactions: [], attachments: [] };
}
afterEach(() => vi.useRealTimers());

it("observes a scheduled exact-run recovery through success within the original deadline and run limit", async () => {
  vi.useFakeTimers();
  const state = snapshot(), deadline = Date.now() + 5_000;
  const pending = waitFor(deadline, async () => {
    validateAgentTaskState(context, "task", state, 1, [], deadline);
    return state;
  }, value => agentTaskSettled(value, 1), "agent_task_not_completed");
  const assertion = expect(pending).resolves.toBe(state);
  await vi.advanceTimersByTimeAsync(1_000);
  state.taskRuns[0]!.status = "succeeded";
  state.taskRuns[0]!.nativePhase = "committed";
  state.currentIssue.status = "done";
  await vi.advanceTimersByTimeAsync(1_000);
  await assertion;
  expect(state.taskRuns.map(run => run.id)).toEqual(["run"]);
});

it.each([
  ["terminal phase", (run: Row) => { run.nativePhase = "terminal_failure"; }],
  ["terminal cause", (run: Row) => { run.errorCode = run.execution.cause = "native_provider_terminal_failed"; }],
  ["no retry owner", (run: Row) => { run.execution.recoveryOwner = "board"; }],
  ["exhausted retry", (run: Row) => { run.execution.attempt = 3; }],
  ["late retry", (run: Row) => { run.execution.retryAt = new Date(Date.now() + 6_000).toISOString(); }],
  ["different successor", (run: Row) => { run.execution.successorRunId = "other-run"; }],
  ["foreign model", (run: Row) => { run.runnerProfileJson.nativeExecutionInput.provider.model = "other"; }],
  ["foreign task", (run: Row) => { run.nativeIssueId = "other"; }],
] as const)("keeps %s fatal", (_label, change) => {
  const state = snapshot(); change(state.taskRuns[0]!);
  expect(() => validateAgentTaskState(context, "task", state, 1, [], Date.now() + 5_000)).toThrow();
});

it("never counts a pending recovery as settled even if the task snapshot says done", () => {
  const state = snapshot(); state.currentIssue.status = "done";
  expect(agentTaskSettled(state, 1)).toBe(false);
});

it("keeps the original campaign deadline when recovery never completes", async () => {
  vi.useFakeTimers();
  const state = snapshot(), deadline = Date.now() + 2_000;
  const pending = waitFor(deadline, async () => {
    validateAgentTaskState(context, "task", state, 1, [], deadline);
    return state;
  }, value => agentTaskSettled(value, 1), "agent_task_not_completed");
  const assertion = expect(pending).rejects.toMatchObject({ code: "agent_task_not_completed" });
  await vi.advanceTimersByTimeAsync(2_000);
  await assertion;
});


it.each([null, undefined])("accepts an explicitly scheduled same-run retry with successor %s", successor => {
  const state = snapshot(); state.taskRuns[0]!.execution.successorRunId = successor;
  expect(() => validateAgentTaskState(context, "task", state, 1, [], Date.now() + 5_000)).not.toThrow();
  expect(() => validateAgentTaskState(context, "task", state, 1)).toThrow("agent_run_failed");
  expect(() => validateAgentTaskState(context, "task", state, 0, [], Date.now() + 5_000)).toThrow("agent_task_binding_mismatch");
});

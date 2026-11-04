import { describe, expect, it } from "vitest";
import { fixtureReplyStoredOnce, validateAgentTaskState } from "./agent-flows.js";
import { SLUGIFY_REVISION } from "../everyday-cases.js";
import { activeNativeTurnStarted, nativeCancellationHasNoLaterWork, nativeStopAcknowledged, nativeWorkEvents } from "../stop-redirect-flow.js";
import { parseTargetConfig } from "./catalog.js";
import type { JourneyContext } from "./types.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import { agentJourneyRuns, journeyRequiredChecks } from "./success-contract.js";

const context = { company: { id: "qa-company" }, environmentId: "qa-daytona",
  agent: { id: "owned-agent", provider: "opencode", model: "qa-model", runtimeMode: "native" } } as JourneyContext;

it("accepts the QA editor's escaped underscore while rejecting lost, duplicate, foreign or changed replies", () => {
  const before = [{ id: "old", authorUserId: "user", body: SLUGIFY_REVISION }];
  const reply = { id: "new", authorUserId: "user", body: SLUGIFY_REVISION.replaceAll("_", "\\_") };
  expect(fixtureReplyStoredOnce(before, [...before, reply], "user", SLUGIFY_REVISION)).toBe(true);
  for (const after of [before, [...before, reply, { ...reply, id: "duplicate" }], [...before, { ...reply, authorUserId: "other" }],
    [...before, { ...reply, body: reply.body.replace("optional", "required") }], [...before, { ...reply, body: reply.body + " extra" }]]) {
    expect(fixtureReplyStoredOnce(before, after, "user", SLUGIFY_REVISION)).toBe(false);
  }
});
function state() {
  return { currentIssue: { id: "owned-task", companyId: "qa-company", assigneeAgentId: "owned-agent", status: "done" },
    taskRuns: [{ id: "run", issueId: "owned-task", companyId: "qa-company", agentId: "owned-agent", status: "succeeded", runtimeMode: "native",
      contextSnapshot: { paperclipEnvironment: { id: "qa-daytona" } }, runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "qa-model" } } } }],
    comments: [], interactions: [], attachments: [] };
}
describe("deployed agent journey evidence", () => {
  it.each(["tool.execution.started", "turn.started", "message.delta", "item.delta", "item.completed"])("rejects %s after cancellation even when cleanup's first snapshot already contains it", eventType => {
    const event = (type: string) => ({ id: type, payload: { prpEvent: { eventType: type } } });
    const stopped = [event("turn.started"), event("item.delta"), event("turn.cancelled")];
    expect(nativeCancellationHasNoLaterWork(stopped)).toBe(true);
    expect(nativeCancellationHasNoLaterWork([...stopped, event("usage.reported")])).toBe(true);
    expect(nativeCancellationHasNoLaterWork([...stopped, event(eventType)])).toBe(false);
    expect(nativeCancellationHasNoLaterWork(stopped.slice(0, -1))).toBe(false);
  });
  it("requires an active native turn before the Stop boundary, including the native completion race", () => {
    const run = { runtimeMode: "native", status: "running" };
    const event = (eventType: string) => ({ payload: { prpEvent: { eventType } } });
    expect(activeNativeTurnStarted(run, [])).toBe(false);
    expect(activeNativeTurnStarted(run, [event("session.opened")])).toBe(false);
    expect(activeNativeTurnStarted(run, [event("turn.started")])).toBe(true);
    for (const terminal of ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]) {
      expect(activeNativeTurnStarted(run, [event("turn.started"), event(terminal)])).toBe(false);
    }
    expect(activeNativeTurnStarted({ ...run, status: "succeeded" }, [event("turn.started")])).toBe(false);
    expect(activeNativeTurnStarted({ ...run, runtimeMode: "legacy" }, [event("turn.started")])).toBe(false);
  });
  it.each(["tool.execution.started", "turn.started", "message.delta", "item.delta", "item.completed"])("rejects a quiet-Stop claim when the retired turn emits %s", eventType => {
    const event = (type: string) => ({ id: type, payload: { prpEvent: { eventType: type, payload: { text: "old turn kept writing" } } } });
    const before = [event("turn.cancelled")];
    expect(nativeWorkEvents([...before, event(eventType)])).not.toEqual(nativeWorkEvents(before));
    expect(nativeWorkEvents([...before, event("usage.reported")])).toEqual(nativeWorkEvents(before));
  });
  it("accepts bound native work and fails plausible passes from a different target, agent, model or task", () => {
    expect(() => validateAgentTaskState(context, "owned-task", state(), 3)).not.toThrow();
    const substitutions = [
      (s: ReturnType<typeof state>) => { s.currentIssue.companyId = "other"; },
      (s: ReturnType<typeof state>) => { s.currentIssue.assigneeAgentId = "other"; },
      (s: ReturnType<typeof state>) => { s.taskRuns[0]!.issueId = "other"; },
      (s: ReturnType<typeof state>) => { s.taskRuns[0]!.agentId = "other"; },
      (s: ReturnType<typeof state>) => { s.taskRuns[0]!.contextSnapshot.paperclipEnvironment.id = "local"; },
      (s: ReturnType<typeof state>) => { s.taskRuns[0]!.runnerProfileJson.nativeExecutionInput.provider.model = "other"; },
      (s: ReturnType<typeof state>) => { s.taskRuns[0]!.runtimeMode = "legacy"; },
      (s: ReturnType<typeof state>) => { s.taskRuns[0]!.status = "failed"; },
      (s: ReturnType<typeof state>) => { s.taskRuns[0]!.status = "cancelled"; },
    ];
    for (const substitute of substitutions) { const s = state(); substitute(s); expect(() => validateAgentTaskState(context, "owned-task", s, 3)).toThrow(); }
    const s = state(); s.taskRuns.push(s.taskRuns[0]!);
    expect(() => validateAgentTaskState(context, "owned-task", s, 1)).toThrow();
  });
  it("permits only the explicitly stopped run, while still checking its deployment binding", () => {
    const s = state(); s.taskRuns[0]!.status = "cancelled";
    expect(() => validateAgentTaskState(context, "owned-task", s, 3, ["run"])).not.toThrow();
    s.taskRuns[0]!.companyId = "other";
    expect(() => validateAgentTaskState(context, "owned-task", s, 3, ["run"])).toThrow();
  });
  it("requires explicit paid run limits for a mixed deployment campaign", () => {
    const config = { version: 1, id: "qa", mode: "existing-cloud", adapterModule: "/private/provider.mjs",
      executionEnvironment: "daytona", journeys: ["task-create", "ask-question", "plan-revise-accept", "build-revise", "protected-actions", "create-skill-studio", "stop-redirect"],
      baseline: { features: {}, connections: [] }, limits: { durationMs: 1_800_000, modelBudgetCents: 500, maxRuns: 14 } };
    expect(parseTargetConfig(config).journeys).toEqual(config.journeys);
    expect(() => parseTargetConfig({ ...config, limits: { ...config.limits, maxRuns: 1 } })).toThrow("agent_journeys_require_bounded_runs");
  });
  it("does not mistake a cancelled status or pending native intent for an acknowledged Stop", () => {
    const run = { id: "run", companyId: "qa-company", issueId: "owned-task", status: "cancelled", runtimeMode: "native", resultJson: { cancelledByActorType: "user", cancelledByUserId: "qa-user",
      cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "qa-user" } },
      startupCancellation: { requestedAt: "2026-10-29T00:00:00Z", beforeNativeSelection: false }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", intentId: "native-cancellation:00000000-0000-4000-8000-000000000001", companyId: "qa-company", runId: "run", issueId: "owned-task", scope: "run",
      dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "intent", acknowledgementAuditId: "ack" } } };
    expect(nativeStopAcknowledged(run, "qa-company", "owned-task", "qa-user")).toBe(true);
    for (const change of [{ dispatchState: "pending" }, { runId: "other" }, { scope: "task" }, { effects: [] }, { acknowledgementAuditId: "intent" }]) {
      const changed = structuredClone(run); Object.assign(changed.resultJson.nativeCancellation, change);
      expect(nativeStopAcknowledged(changed, "qa-company", "owned-task", "qa-user")).toBe(false);
    }
    expect(nativeStopAcknowledged(run, "qa-company", "owned-task", "other-user")).toBe(false);
    expect(nativeStopAcknowledged({ ...run, resultJson: {} }, "qa-company", "owned-task", "qa-user")).toBe(false);
  });
  it.each(Object.keys(agentJourneyRuns))("retained %s successes require every story check and the exact run receipts", id => {
    const count = agentJourneyRuns[id as keyof typeof agentJourneyRuns];
    const result = { schema: "paperclip.runner-e2e.result/v2", executionId: `product-journeys.qa.configured-agent.daytona.${id}`,
      suiteId: "product-journeys", suiteDefinitionHash: "test", profileId: "configured-agent", environmentId: "daytona", caseId: id,
      provider: "opencode", model: "qa-model", runtimeMode: "native", status: "passed", cleanup: "passed", attempt: 1,
      startedAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z", durationMs: 1000,
      runIds: Array.from({ length: count }, (_, index) => `owned-run-${index}`),
      productJourney: { outcome: "passed", startingState: "recipe", privacy: "private", resourceDisposition: "retained",
        phases: [{ phase: "journey", outcome: "passed" }], checks: journeyRequiredChecks[id]!.map(id => ({ id, passed: true })),
        deployment: { kind: "cloud", targetId: "qa", origin: "https://qa.test.paperclip.app", commit: "a".repeat(40),
          cloudRelease: "b".repeat(40), runtimeImage: "pinned-image", configurationHash: "test" } } };
    expect(() => validateRetainedRunnerResult(result)).not.toThrow();
    for (let index = 0; index < result.productJourney.checks.length; index++) {
      const missing = structuredClone(result); missing.productJourney.checks.splice(index, 1);
      expect(() => validateRetainedRunnerResult(missing)).toThrow("result.productJourney");
    }
    const extraRun = structuredClone(result); extraRun.runIds.push("foreign-run");
    expect(() => validateRetainedRunnerResult(extraRun)).toThrow("result.agentJourneyRun");
    const falseCheck = structuredClone(result); falseCheck.productJourney.checks.push({ id: "independent-extra-check", passed: false });
    expect(() => validateRetainedRunnerResult(falseCheck)).toThrow("result.productJourney");
  });
});

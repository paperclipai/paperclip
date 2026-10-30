import { describe, expect, it } from "vitest";
import { activeFollowupBoundary, activeFollowupOutcome, sameActiveFollowupBoundary } from "./active-followup-evidence.js";
import { activeFollowupStory } from "./active-followup-flow.js";
import { agentJourneyRunCountMatches, journeyRequiredChecks } from "./success-contract.js";
import { parseTargetConfig, preparationPreview } from "./catalog.js";
import { validateRetainedRunnerResult } from "../result-validation.js";

const run = { id: "run", companyId: "company", agentId: "agent", issueId: "issue", runtimeMode: "native", status: "running" };
function event(seq: number, type: string, payload = {}): Record<string, any> {
  return { seq, eventType: type, runId: run.id, companyId: run.companyId, agentId: run.agentId,
    protocolSchemaVersion: 2, sourceEventId: `source-${seq}`, sourceInstanceId: "source", sourceSeq: seq,
    payload: { prpEvent: { schema: "paperclip.prp.event.v2", schemaVersion: 2, eventType: type, runId: run.id,
      sourceKind: "runner", sourceEventId: `source-${seq}`, sourceInstanceId: "source", sourceSeq: seq, payload } } };
}
const command = { schema: "paperclip.tool.execution.v1", executionId: "wait", transport: "builtin", operation: "execute", name: "bash", status: "running" };
const events = () => [event(1, "turn.started"), event(2, "tool.execution.started", command)];
const boundary = () => activeFollowupBoundary(run, events())!;
const outcome = () => ({ issueId: "issue", agentId: "agent", before: boundary(), after: boundary(),
  runs: [{ ...run, status: "succeeded" }], expectedReply: "Friday UPDATED", replies: [{ runId: "run", body: "Friday UPDATED" }],
  storedFollowupCount: 1, queuedCommentCount: 0, finalIssueStatus: "done" });

describe("deployment-independent active follow-up", () => {
  it("withholds the changed requirement and result marker until the follow-up", () => {
    const story = activeFollowupStory("campaign-123");
    expect(story.first).toContain("sleep 45"); expect(story.first).toContain(story.reference);
    expect(story.first).not.toContain(story.marker); expect(story.first).not.toContain("Friday");
    expect(story.followup).toContain(story.expectedReply);
  });
  it("requires a bound running native turn and an actual pending shell execution", () => {
    expect(boundary()).toMatchObject({ runId: "run", executionId: "wait", startedSeq: 2 });
    for (const rows of [[], events().slice(0, 1), [...events(), event(3, "tool.execution.completed", { ...command, status: "completed" })],
      [...events(), event(3, "turn.completed")], [events()[0]!, event(2, "tool.execution.started", { ...command, operation: "read" })],
      [events()[0]!, event(2, "tool.execution.started", { ...command, name: "paperclip_finish" })],
      [events()[0]!, event(2, "tool.execution.started", { ...command, transport: "mcp" })],
      [events()[0]!, event(3, "tool.execution.started", command)],
      [...events(), event(3, "tool.execution.started", command)]]) expect(activeFollowupBoundary(run, rows)).toBeNull();
    for (const field of ["companyId", "agentId", "runId", "sourceEventId", "sourceInstanceId", "sourceSeq", "protocolSchemaVersion"]) {
      const rows = events(); rows[1]![field] = "wrong"; expect(activeFollowupBoundary(run, rows)).toBeNull();
    }
    const rows = events(); rows[0]!.payload.prpEvent.sourceKind = "control_plane";
    expect(activeFollowupBoundary(run, rows)).toBeNull();
    for (const changed of [{ status: "succeeded" }, { runtimeMode: "legacy" }]) expect(activeFollowupBoundary({ ...run, ...changed }, events())).toBeNull();
  });
  it("proves the same execution remains active after the user message is stored", () => {
    expect(sameActiveFollowupBoundary(boundary(), boundary())).toBe(true);
    for (const changed of [null, { ...boundary(), executionId: "other" }, { ...boundary(), startedRowSha256: "changed" }])
      expect(sameActiveFollowupBoundary(boundary(), changed)).toBe(false);
  });
  it("accepts one steered run or one normal successor with the unique late answer", () => {
    expect(activeFollowupOutcome(outcome())).toBe(true);
    const value = outcome(); value.runs.push({ ...value.runs[0]!, id: "successor" }); value.replies[0]!.runId = "successor";
    expect(activeFollowupOutcome(value)).toBe(true);
  });
  it("rejects lost input, duplicate delivery/work, stale answers and unfinished queues", () => {
    const changes = [
      (v: ReturnType<typeof outcome>) => { v.storedFollowupCount = 0; },
      (v: ReturnType<typeof outcome>) => { v.storedFollowupCount = 2; },
      (v: ReturnType<typeof outcome>) => { v.queuedCommentCount = 1; },
      (v: ReturnType<typeof outcome>) => { v.finalIssueStatus = "in_progress"; },
      (v: ReturnType<typeof outcome>) => { v.replies = []; },
      (v: ReturnType<typeof outcome>) => { v.replies.push(v.replies[0]!); },
      (v: ReturnType<typeof outcome>) => { v.replies[0]!.body = "Monday"; },
      (v: ReturnType<typeof outcome>) => { v.replies[0]!.runId = "other"; },
      (v: ReturnType<typeof outcome>) => { v.runs[0]!.status = "failed"; },
      (v: ReturnType<typeof outcome>) => { v.runs[0]!.agentId = "other"; },
      (v: ReturnType<typeof outcome>) => { v.runs[0]!.issueId = "other"; },
      (v: ReturnType<typeof outcome>) => { v.runs = []; },
      (v: ReturnType<typeof outcome>) => { v.runs.push(v.runs[0]!); },
      (v: ReturnType<typeof outcome>) => { v.runs.push({ ...v.runs[0]!, id: "successor" }); },
    ];
    for (const change of changes) { const value = outcome(); change(value); expect(activeFollowupOutcome(value)).toBe(false); }
  });
  it("allows a maximum of two declared runs while preserving every other exact bound", () => {
    for (const count of [1, 2]) expect(agentJourneyRunCountMatches("followup-while-running", count)).toBe(true);
    for (const count of [undefined, 0, 3, NaN, 1.5]) expect(agentJourneyRunCountMatches("followup-while-running", count)).toBe(false);
    expect(agentJourneyRunCountMatches("build-revise", 1)).toBe(false);
    const config = { version: 1, id: "qa", mode: "existing-cloud", adapterModule: "/private/provider.mjs", journeys: ["followup-while-running"],
      executionEnvironment: "daytona", baseline: { features: {}, connections: [] }, limits: { durationMs: 600_000, modelBudgetCents: 100, maxRuns: 2 } };
    expect(preparationPreview(parseTargetConfig(config)).journeys[0]).toMatchObject({ id: "followup-while-running", paid: true });
    expect(() => parseTargetConfig({ ...config, limits: { ...config.limits, maxRuns: 1 } })).toThrow("agent_journeys_require_bounded_runs");
  });
  it("retains one-run and two-run passes only with the whole success contract", () => {
    const result = { schema: "paperclip.runner-e2e.result/v2", executionId: "product-journeys.qa.configured-agent.daytona.followup-while-running",
      suiteId: "product-journeys", suiteDefinitionHash: "test", profileId: "configured-agent", environmentId: "daytona", caseId: "followup-while-running",
      provider: "opencode", model: "configured-model", runtimeMode: "native", status: "passed", cleanup: "passed", attempt: 1,
      startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000, runIds: ["run"],
      productJourney: { outcome: "passed", startingState: "recipe", privacy: "private", resourceDisposition: "retained",
        phases: [{ phase: "journey", outcome: "passed" }], checks: journeyRequiredChecks["followup-while-running"]!.map(id => ({ id, passed: true })),
        deployment: { kind: "cloud", targetId: "qa", origin: "https://example.test", commit: "a".repeat(40), cloudRelease: "b".repeat(40), runtimeImage: "pinned", configurationHash: "test" } } };
    for (const runIds of [["run"], ["run", "successor"]]) expect(() => validateRetainedRunnerResult({ ...result, runIds })).not.toThrow();
    for (const runIds of [[], ["a", "b", "c"]]) expect(() => validateRetainedRunnerResult({ ...result, runIds })).toThrow("result.agentJourneyRun");
    for (const check of result.productJourney.checks) expect(() => validateRetainedRunnerResult({ ...result, productJourney: { ...result.productJourney,
      checks: result.productJourney.checks.filter(row => row.id !== check.id) } })).toThrow("result.productJourney");
  });
});

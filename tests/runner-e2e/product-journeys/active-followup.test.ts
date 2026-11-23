import { describe, expect, it } from "vitest";
import { canonicalProviderEventsFromCodex, canonicalProviderEventsFromAcpxRuntimeEvent, canonicalProviderEventsFromOpenCodePart } from "../../../packages/paperclip-runner/src/provider-events.js";
import { activeFollowupBoundary, activeFollowupOutcome, sameActiveFollowupBoundary } from "./active-followup-evidence.js";
import { activeFollowupStory, observeActiveFollowupCommand } from "./active-followup-flow.js";
import { journeyRequiredChecks } from "./success-contract.js";
import { parseTargetConfig, preparationPreview, agentJourneyRunCountValid } from "./catalog.js";
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
// Synthetic identity and filler rows; the v1 operation/transport/name/readOnly
// shape and native/source sequence positions match observed deployment metadata.
function legacyEvents(change: Record<string, unknown> = {}): Record<string, any>[] {
  const rows: Record<string, any>[] = Array.from({ length: 81 }, (_, index) => ({ seq: index + 1, eventType: "adapter.message" }));
  const bind = (seq: number, sourceSeq: number, type: string, payload: Record<string, unknown>) => {
    const row = event(seq, type, payload);
    row.protocolSchemaVersion = 1; row.sourceSeq = sourceSeq;
    Object.assign(row.payload.prpEvent, { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceSeq });
    return row;
  };
  rows[70] = bind(71, 9, "turn.started", { status: "inProgress" });
  rows[80] = bind(81, 12, "tool.execution.started", { ...command, namespace: null, operation: "unknown", readOnly: false, ...change });
  return rows;
}
const outcome = () => ({ issueId: "issue", agentId: "agent", before: boundary(), after: boundary(),
  runs: [{ ...run, status: "succeeded" }], expectedReply: "Friday UPDATED", marker: "UPDATED", replies: [{ runId: "run", body: "Friday UPDATED" }],
  storedFollowupCount: 1, queuedCommentCount: 0, finalIssueStatus: "done" });

describe("deployment-independent active follow-up", () => {
  it("withholds the changed requirement and result marker until the follow-up", () => {
    const story = activeFollowupStory("campaign-123");
    expect(story.first).toContain("sleep 90"); expect(story.first).toContain(story.reference);
    expect(story.first).not.toContain(story.marker); expect(story.first).not.toContain("Friday");
    expect(story.followup).toContain(story.expectedReply);
  });
  it("requires a bound running native turn and an actual pending shell execution", () => {
    expect(boundary()).toMatchObject({ runId: "run", executionId: "wait", startedSeq: 2 });
    for (const rows of [[], events().slice(0, 1), [...events(), event(3, "tool.execution.completed", { ...command, status: "completed" })],
      [...events(), event(3, "turn.completed")], [...events(), event(3, "turn.started")], [events()[0]!, event(2, "tool.execution.started", { ...command, operation: "read" })],
      [events()[0]!, event(2, "tool.execution.started", { ...command, readOnly: true })],
      [events()[0]!, event(2, "tool.execution.started", { ...command, name: "paperclip_finish" })],
      [events()[0]!, event(2, "tool.execution.started", { ...command, name: "paperclip_block" })],
      [events()[0]!, event(2, "tool.execution.started", { ...command, namespace: "paperclip" })],
      [events()[0]!, event(2, "tool.execution.started", { ...command, name: null })],
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
  it("accepts canonical Codex command text and ACP display titles without provider-name coupling", () => {
    const codex = canonicalProviderEventsFromCodex("item/started", {
      item: { id: "wait", type: "commandExecution", command: "sleep 90", status: "inProgress" },
    })[0]!;
    const acp = canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "tool_call", tag: "tool_call", toolCallId: "wait", title: "Bounded settlement fixture", kind: "execute", status: "pending",
    } as never, "fallback")[0]!;
    expect(codex.payload).toMatchObject({ transport: "process", operation: "execute", name: "sleep 90", status: "running" });
    expect(acp.payload).toMatchObject({ transport: "builtin", operation: "execute", name: "Bounded settlement fixture", readOnly: false, status: "running" });
    for (const mapped of [codex, acp]) {
      expect(activeFollowupBoundary(run, [event(1, "turn.started"), event(2, mapped.eventType, mapped.payload)])).toMatchObject({ runId: "run", startedSeq: 2 });
    }
  });
  it("accepts the real OpenCode shell fixture and rejects semantic calls normalized as builtin execute", () => {
    const mapped = (tool: string, callID = "") => canonicalProviderEventsFromOpenCodePart({
      id: "wait", type: "tool", tool, callID, state: { status: "pending", input: { command: "sleep 90" } },
    })[0]!;
    const shell = mapped("bash");
    expect(shell.payload).toMatchObject({ transport: "builtin", operation: "execute", name: "bash", readOnly: false, status: "running" });
    expect(activeFollowupBoundary(run, [event(1, "turn.started"), event(2, shell.eventType, shell.payload)])).toMatchObject({ runId: "run", startedSeq: 2 });
    for (const semantic of [mapped("paperclip_finish"), mapped("paperclip_block"), mapped("paperclip_report_progress"),
      mapped("paperclip_paperclip_finish"), mapped("unknown", "functions.paperclip_block:0"),
      mapped("functions.paperclip_finish"), mapped("mcp__paperclip__paperclip_block"), mapped("paperclip.paperclip_report_progress")]) {
      expect(semantic.payload).toMatchObject({ transport: "builtin", operation: "execute", readOnly: false, status: "running" });
      expect(activeFollowupBoundary(run, [event(1, "turn.started"), event(2, semantic.eventType, semantic.payload)])).toBeNull();
    }
    for (const name of [null, "", " ", "unknown", "tool", "tool call", "tool_call", "tool-call"]) {
      expect(activeFollowupBoundary(run, [event(1, "turn.started"), event(2, shell.eventType, { ...shell.payload, name })])).toBeNull();
    }
  });
  it("recognizes the observed legacy v1 builtin bash shape without admitting unknown operations generally", () => {
    const before = activeFollowupBoundary(run, legacyEvents());
    expect(before).toMatchObject({ runId: "run", executionId: "wait", startedSeq: 81, sourceSeq: 12 });
    for (const change of [{ name: "unknown" }, { name: "custom-command" }, { name: "paperclip_finish" }, { name: "paperclip_block" },
      { name: "paperclip_report_progress" }, { name: "functions.paperclip_finish" }, { readOnly: true }, { readOnly: undefined },
      { transport: "process" }, { namespace: "paperclip" }]) expect(activeFollowupBoundary(run, legacyEvents(change))).toBeNull();
    for (const field of ["companyId", "agentId", "runId", "sourceEventId", "sourceInstanceId", "sourceSeq", "protocolSchemaVersion"]) {
      const rows = legacyEvents(); rows[80]![field] = "foreign";
      expect(activeFollowupBoundary(run, rows)).toBeNull();
    }
    expect(activeFollowupBoundary(run, [events()[0]!, event(2, "tool.execution.started", { ...command, operation: "unknown", readOnly: false })])).toBeNull();
    const after = legacyEvents();
    after.push(event(82, "tool.execution.progressed", { ...after[80]!.payload.prpEvent.payload }));
    expect(sameActiveFollowupBoundary(before!, activeFollowupBoundary(run, after))).toBe(true);
    after.push(event(83, "tool.execution.completed", { ...after[80]!.payload.prpEvent.payload, status: "completed" }));
    expect(activeFollowupBoundary(run, after)).toBeNull();
  });
  it("fails promptly after owned work settles without an observed active boundary", async () => {
    let eventReads = 0;
    const load = async () => { eventReads++; return legacyEvents(); };
    for (const taskRuns of [[{ ...run, status: "succeeded" }], [{ ...run, status: "succeeded" }, { ...run, id: "second", status: "succeeded" }]])
      await expect(observeActiveFollowupCommand(taskRuns, load)).rejects.toMatchObject({ outcome: "failed", code: "followup_native_command_not_active" });
    expect(eventReads).toBe(0);
    for (const taskRuns of [[], [{ ...run, status: "queued" }], [{ ...run, status: "succeeded" }, { ...run, id: "second", status: "queued" }]])
      expect((await observeActiveFollowupCommand(taskRuns, load)).boundary).toBeNull();
    expect(eventReads).toBe(0);
    expect((await observeActiveFollowupCommand([run], load)).boundary).toMatchObject({ runId: "run", startedSeq: 81 });
    expect(eventReads).toBe(1);
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
      (v: ReturnType<typeof outcome>) => { v.replies.push({ runId: "run", body: "UPDATED again" }); },
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
    for (const count of [1, 2]) expect(agentJourneyRunCountValid("followup-while-running", count)).toBe(true);
    for (const count of [undefined, 0, 3, NaN, 1.5]) expect(agentJourneyRunCountValid("followup-while-running", count)).toBe(false);
    expect(agentJourneyRunCountValid("build-revise", 1)).toBe(false);
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

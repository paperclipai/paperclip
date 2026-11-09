import { expect, it, vi } from "vitest";
import { gradePiProviderDeath, runPiPendingProviderDeath, PI_DEATH_MARKER } from "./pi-native-provider-death-flow.js";
import { classifyFailure } from "./failure-classifier.js";
import { observePiPendingNativeInput } from "./pi-native-restart-flow.js";

type Row = Record<string, any>;
vi.mock("@playwright/test", () => ({ expect: (locator: { count(): number }) => ({
  toHaveCount: async (expected: number) => expect(locator.count()).toBe(expected),
  toBeVisible: async () => expect(locator.count()).toBe(1),
}) }));
function fixture(fallback = true) {
  const question = { schema: "paperclip.question_set.v1", questions: [{ id: "answer", header: "Pi native provider death", prompt: "Answer", answerMode: "text", required: true }] };
  const request = { schema: "paperclip.runtime_request.v2", requestKind: "runtime", type: "input", status: "pending", requestId: "request", turnId: "turn", itemId: "request", input: question,
    origin: { adapter: "acpx-runtime-sidecar", provider: "pi", method: "elicitation/create" } };
  const wrap = (eventType: string, sourceSeq: number, payload: Row): Row => ({ companyId: "company", runId: "run", seq: sourceSeq, protocolSchemaVersion: 1, eventType,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn", itemId: "request",
      normalizedSessionId: "session", sourceInstanceId: "runner", sourceSeq, sourceEventId: `runner:run:${sourceSeq}`, payload } } });
  const state = { issue: { id: "issue", companyId: "company", status: "in_progress" }, runs: [{ id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "running", nativeSessionId: "session", runnerInstanceId: "runner" } as Row],
    interactions: [{ id: "original", companyId: "company", issueId: "issue", kind: "ask_user_questions", sourceRunId: "run", status: "pending", result: null,
      continuationPolicy: "none", resolverPolicy: "human_only", idempotencyKey: "paperclip-runner-question:run:request", payload: { runtimeRequestId: "request", questionSet: question } } as Row] };
  const events = [wrap("turn.started", 1, {}), wrap("runtime_request.created", 2, { request })];
  const pending = observePiPendingNativeInput(state, events, "company", "Pi native provider death");
  const before = structuredClone({ state, events });
  state.runs[0]!.status = "failed"; state.issue.status = "blocked"; state.interactions[0]!.status = "expired";
  events.push(wrap("runtime_request.expired", 3, { requestId: "request", requestKind: "runtime", requestType: "input", turnId: "turn", itemId: "request", reason: "provider_process_lost", replayAllowed: false, request }),
    wrap("turn.failed", 4, { code: "provider_transport_lost" }));
  if (fallback) state.interactions.push({ ...structuredClone(state.interactions[0]!), id: "fallback", status: "pending", continuationPolicy: "wake_assignee", idempotencyKey: "runtime-input-durable:v1:run:request" });
  state.interactions[0]!.result = { version: 1, answers: [], ...(fallback ? { expirationReason: "superseded_by_newer_interaction", supersededByInteractionId: "fallback" } : {}) };
  const grade = () => gradePiProviderDeath(state, events, pending, question);
  return { state, events, pending, question, wrap, grade, before };
}
it.each([false, true])("accepts production loss with distinct fallback=%s without claiming restoration", fallback => {
  expect(fixture(fallback).grade()).toEqual({ originalCardExpired: true, replayAllowed: false, originalProviderRestored: false, fallbackInteractionId: fallback ? "fallback" : null });
});
it.each([
  ["wrong issue disposition", (f: ReturnType<typeof fixture>) => { f.state.issue.status = "in_progress"; }],
  ["completed issue", (f: ReturnType<typeof fixture>) => { f.state.issue.status = "done"; }],
  ["answered expired card", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.result.answers = [{ questionId: "answer", otherText: "stale" }]; }],
  ["missing expired result", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.result = null; }],
  ["foreign supersession", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.result.supersededByInteractionId = "other"; }],
  ["missing expiry", (f: ReturnType<typeof fixture>) => { f.events.splice(2, 1); }],
  ["model-only claim", f => { f.events[2] = { eventType: "assistant.message", payload: { text: "The callback expired" } }; }],
  ["controller injected expiry", f => { f.events[2]!.payload.prpEvent.sourceKind = "control_plane"; }],
  ["cancelled instead of lost", f => { f.events[2]!.eventType = f.events[2]!.payload.prpEvent.eventType = "runtime_request.cancelled"; }],
  ["resolved instead of lost", f => { f.events[2]!.eventType = f.events[2]!.payload.prpEvent.eventType = "runtime_request.resolved"; }],
  ["normal durable handoff", f => { f.events[2]!.payload.prpEvent.payload.reason = "durable_handoff"; }],
  ["replay allowed", f => { f.events[2]!.payload.prpEvent.payload.replayAllowed = true; }],
  ["foreign request", f => { f.events[2]!.payload.prpEvent.payload.requestId = "other"; }],
  ["foreign item", f => { f.events[2]!.payload.prpEvent.payload.itemId = "other"; }],
  ["missing canonical request", f => { delete f.events[2]!.payload.prpEvent.payload.request; }],
  ["replaced canonical question", f => { f.events[2]!.payload.prpEvent.payload.request = { ...f.events[2]!.payload.prpEvent.payload.request, input: {} }; }],
  ["duplicate expiry", f => { f.events.push(f.wrap("runtime_request.expired", 5, f.events[2]!.payload.prpEvent.payload)); }],
  ["new native turn", f => { f.events.push(f.wrap("turn.started", 5, {})); }],
  ["successful provider", f => { f.state.runs[0]!.status = "succeeded"; }],
  ["Stop cancellation", f => { f.state.runs[0]!.resultJson = { nativeCancellation: {} }; }],
  ["worker failure without turn failure", f => { f.events.pop(); }],
  ["completed turn", f => { f.events[3]!.eventType = f.events[3]!.payload.prpEvent.eventType = "turn.completed"; }],
  ["terminal before expiry", f => { f.events[3]!.seq = 0; }],
  ["second run", f => { f.state.runs.push({ ...f.state.runs[0], id: "other" }); }],
  ["restored session", f => { f.state.runs[0]!.nativeSessionId = "restored"; }],
  ["foreign company", f => { f.events[2]!.companyId = "foreign"; }],
  ["foreign source", f => { f.events[2]!.payload.prpEvent.sourceInstanceId = "foreign"; }],
  ["original still pending", f => { f.state.interactions[0]!.status = "pending"; }],
  ["answered original", f => { f.state.interactions[0]!.status = "answered"; }],
  ["rebound original card", f => { f.state.interactions[0]!.sourceRunId = "other"; }],
  ["duplicate fallback", f => { f.state.interactions.push(structuredClone(f.state.interactions[1]!)); }],
  ["fallback masquerading as callback", f => { f.state.interactions[1]!.continuationPolicy = "none"; }],
  ["answered fallback", f => { f.state.interactions[1]!.status = "answered"; }],
  ["foreign fallback", f => { f.state.interactions[1]!.idempotencyKey = "foreign"; }],
] satisfies Array<[string, (f: ReturnType<typeof fixture>) => void]>)("rejects %s", (_name, mutate) => {
  const f = fixture(); mutate(f); expect(f.grade).toThrow();
});

async function journey(staleStatus = 409, markerEffect = false) {
  const f = fixture(), evidence = new Map<string, unknown>(), posted: string[] = [];
  let lost = false, signals = 0, retired = false;
  Object.assign(f.before.state.runs[0]!, { contextSnapshot: { executionWorkspaceId: "workspace", paperclipEnvironment: { leaseId: "lease" } },
    runnerProfileJson: { nativeExecutionInput: { binding: { executionWorkspaceId: "workspace" } } } });
  const root = { pid: 21, startTicks: "100", bootId: "boot" };
  const composer: any = { count: () => 1, filter: () => composer };
  const page: any = { getByTestId: (id: string) => id === "issue-detail-header" ? { getByRole: (_role: string, options: Row) => {
    expect(options).toEqual({ name: "Change status (current: Blocked", exact: false }); return { count: () => 1 };
  } } : composer, reload: async () => { expect(retired).toBe(true); },
    locator: (selector: string) => { expect(selector).toBe("#interaction-original"); return { count: () => 1, locator: () => ({ count: () => 0 }) }; } };
  const remoteFixture: any = { binding: { companyId: "company", runId: "run", leaseId: "lease" }, baseline: { scope: { observedPrpEnvironmentLeaseId: "workspace" } },
    terminatePiProvider: async (lease: string) => { expect(lease).toBe("workspace"); expect(lost).toBe(false); signals++; lost = true; return { targetKind: "pi_native_child", signalled: true }; },
    finish: async () => { expect(lost).toBe(true); retired = true; return { complete: true, observedAtMs: 1, watcher: { complete: true },
      processes: { captured: true, root, journal: [root], live: [] }, targets: { [PI_DEATH_MARKER]: { absent: !markerEffect, complete: true, mutationCount: markerEffect ? 1 : 0 } } }; } };
  const result = runPiPendingProviderDeath({ page, api: { request: { post: async (path: string) => { expect(retired).toBe(true); posted.push(path); return { status: () => staleStatus }; } } } as any,
    companyId: "company", deadlineAt: Date.now() + 1000, fixture: remoteFixture,
    load: async () => structuredClone(lost ? f.state : f.before.state), events: async () => structuredClone(lost ? f.events : f.before.events),
    capture: async () => {}, evidence: async (name, value) => { evidence.set(name, value); } });
  return { result, evidence, posted, signalCount: () => signals };
}
it("drives one admitted fault, retirement, original-card UI and both stale public APIs in order", async () => {
  const j = await journey(); expect((await j.result).every(check => check.passed)).toBe(true);
  expect(j.signalCount()).toBe(1); expect(j.posted).toEqual(["/api/issues/issue/interactions/original/respond", "/api/heartbeat-runs/run/runtime-requests/request/resolve"]);
  expect(j.evidence.get("pi-provider-death-result.json")).toMatchObject({ originalProviderRestored: false, fallbackInteractionId: "fallback", staleCardStatus: 409, staleRuntimeStatus: 409 });
});
it("does not accept a successful stale answer despite otherwise valid expiry receipts", async () => {
  const j = await journey(200); await expect(j.result).rejects.toThrow("Both original durable-card"); expect(j.signalCount()).toBe(1);
});
it("rejects a continuation file effect before sending either stale answer", async () => {
  const j = await journey(409, true); await expect(j.result).rejects.toThrow("Exact owned process tree"); expect(j.posted).toEqual([]);
});

it("classifies deliberate-loss proof failures as candidate failures, preserving real API transport errors", () => {
  const f = fixture(); f.state.runs[0]!.status = "succeeded";
  let observed: unknown;
  try { f.grade(); } catch (error) { observed = error; }
  expect(String(observed)).toContain("pi_provider_death_proof:");
  expect(classifyFailure(observed)).toBe("candidate_failure");
  expect(classifyFailure(new Error("GET controller returned 503 service unavailable"))).toBe("transient_infrastructure");
  expect(classifyFailure(new Error("pi_provider_death_proof: secret leak"))).toBe("secret_leak");
  expect(classifyFailure(new Error("pi_provider_death_proof: cleanup incomplete"))).toBe("cleanup_failure");
});

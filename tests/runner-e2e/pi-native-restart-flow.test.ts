import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { gradePiRestartCompletion, observePiRestartPending, runPiPendingControllerRestart } from "./pi-native-restart-flow.js";
import { validatePrpStructuredRunResult } from "../../packages/paperclip-runner/src/protocol/replay-contract.js";

type Row = Record<string, any>;
vi.mock("@playwright/test", () => ({ expect: (locator: { count(): number }) => ({
  toHaveCount: async (expected: number) => expect(locator.count()).toBe(expected),
}) }));

function fixture(adapter = "acpx-runtime-sidecar") {
  const questionSet = { schema: "paperclip.question_set.v1", questions: [{ id: "answer", header: "Pi native restart", prompt: "Answer", answerMode: "text", required: true }] };
  const request = { schema: "paperclip.runtime_request.v2", requestKind: "runtime", type: "input", status: "pending", requestId: "request", turnId: "turn", itemId: "request",
    input: questionSet, origin: { adapter, provider: "pi", method: "elicitation/create" } };
  const wrap = (eventType: string, sourceSeq: number, payload: Row): Row => ({
    companyId: "company", runId: "run", seq: sourceSeq, protocolSchemaVersion: 1, eventType,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn", itemId: "request",
      normalizedSessionId: "session", sourceInstanceId: "runner", sourceSeq, sourceEventId: `runner:run:${sourceSeq}`, payload } },
  });
  const state = { issue: { id: "issue", companyId: "company", status: "in_progress" },
    runs: [{ id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "running", nativeSessionId: "session", runnerInstanceId: "runner" } as Row],
    interactions: [{ id: "interaction", companyId: "company", issueId: "issue", kind: "ask_user_questions", status: "pending", result: null,
      sourceRunId: "run", continuationPolicy: "none", resolverPolicy: "human_only", idempotencyKey: "paperclip-runner-question:run:request",
      payload: { runtimeRequestId: "request", questionSet } } as Row] };
  const events = [wrap("runtime_request.created", 1, { request })];
  const control = (eventType: string, sourceSeq: number, payload: Row): Row => {
    const row = wrap(eventType, sourceSeq + 4, payload), event = row.payload.prpEvent;
    Object.assign(event, { sourceKind: "control_plane", sourceInstanceId: "runner:control", sourceSeq, sourceEventId: `runner:control:run:${sourceSeq}` });
    delete event.itemId;
    Object.assign(row, { sourceInstanceId: event.sourceInstanceId, sourceSeq, sourceEventId: event.sourceEventId });
    return row;
  };
  function finish(answer = "hidden") {
    state.issue.status = "done"; state.runs[0]!.status = "succeeded";
    Object.assign(state.interactions[0]!, { status: "answered", result: { answers: [{ questionId: "answer", optionIds: [], otherText: answer }] } });
    const validated = validatePrpStructuredRunResult({ summary: "Restart question answered", reportedWorkDisposition: "done",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] }, evidence: [], verification: [] });
    if (!validated.ok) throw new Error("Fixture finish result must satisfy the actual production schema");
    const result = validated.result;
    events.push(wrap("runtime_request.resolved", 2, { requestId: "request", turnId: "turn", itemId: "request", action: "submit",
      response: { schema: "paperclip.question_response.v1", answers: { answer: { text: answer } } } }), wrap("turn.completed", 4, { status: "completed" }),
      wrap("run.result.proposed", 3, structuredClone(result)), control("run.result.accepted", 1, { result: structuredClone(result) }),
      control("run.terminal", 2, { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }));
    return { status: "answered", value: answer };
  }
  return { state, events, request, wrap, control, finish };
}

it.each(["acpx-runtime", "acpx-runtime-sidecar"])("accepts mixed runner/control-plane production completion via %s", adapter => {
  const f = fixture(adapter), pending = observePiRestartPending(f.state, f.events, "company"), proof = f.finish();
  expect(gradePiRestartCompletion(f.state, f.events, pending, "hidden", proof)).toBe(true);
});

function actualPendingPrefix() {
  return JSON.parse(readFileSync(new URL("./fixtures/pi-native-restart-actual-prefix.json", import.meta.url), "utf8")) as {
    state: { issue: Row; runs: Row[]; interactions: Row[] }; events: Row[];
  };
}

it.each(["omitted", "null"])("accepts the actual pre-start submission with %s turn ID", representation => {
  const f = actualPendingPrefix();
  if (representation === "null") f.events[0]!.payload.prpEvent.turnId = null;
  expect(observePiRestartPending(f.state, f.events, "company")).toMatchObject({
    runId: "run", turnId: "turn", nativeSessionId: "session", sourceInstanceId: "runner", createdSourceSeq: 195,
  });
});

it.each([
  ["missing start", (f: ReturnType<typeof actualPendingPrefix>) => { f.events.splice(1, 1); }],
  ["start without assigned turn", (f: ReturnType<typeof actualPendingPrefix>) => { delete f.events[1]!.payload.prpEvent.turnId; }],
  ["start with foreign turn", (f: ReturnType<typeof actualPendingPrefix>) => { f.events[1]!.payload.prpEvent.turnId = "other"; }],
  ["foreign submission turn", (f: ReturnType<typeof actualPendingPrefix>) => { f.events[0]!.payload.prpEvent.turnId = "other"; }],
  ["foreign submission session", (f: ReturnType<typeof actualPendingPrefix>) => { f.events[0]!.payload.prpEvent.normalizedSessionId = "other"; }],
  ["foreign submission producer", (f: ReturnType<typeof actualPendingPrefix>) => {
    Object.assign(f.events[0]!.payload.prpEvent, { sourceInstanceId: "other", sourceEventId: "other:run:6" });
  }],
  ["submission after start", (f: ReturnType<typeof actualPendingPrefix>) => {
    f.events[0]!.seq = 29;
    Object.assign(f.events[0]!.payload.prpEvent, { sourceSeq: 8, sourceEventId: "runner:run:8" });
  }],
  ["start after request", (f: ReturnType<typeof actualPendingPrefix>) => {
    f.events[1]!.seq = 223;
    Object.assign(f.events[1]!.payload.prpEvent, { sourceSeq: 196, sourceEventId: "runner:run:196" });
  }],
  ["duplicate submission", (f: ReturnType<typeof actualPendingPrefix>) => {
    const row = structuredClone(f.events[0]!); row.seq = 26;
    Object.assign(row.payload.prpEvent, { sourceSeq: 7, sourceEventId: "runner:run:7" });
    Object.assign(f.events[1]!.payload.prpEvent, { sourceSeq: 8, sourceEventId: "runner:run:8" });
    f.events.push(row);
  }],
  ["duplicate start", (f: ReturnType<typeof actualPendingPrefix>) => {
    const row = structuredClone(f.events[1]!); row.seq = 29;
    Object.assign(row.payload.prpEvent, { sourceSeq: 8, sourceEventId: "runner:run:8" }); f.events.push(row);
  }],
  ["later unbound turn event", (f: ReturnType<typeof actualPendingPrefix>) => {
    const row = structuredClone(f.events[1]!); row.seq = 29; row.eventType = "turn.progress";
    Object.assign(row.payload.prpEvent, { eventType: "turn.progress", turnId: null, sourceSeq: 8, sourceEventId: "runner:run:8" }); f.events.push(row);
  }],
] as const)("rejects %s around an unbound submission", (_label, mutate) => {
  const f = actualPendingPrefix(); mutate(f);
  expect(() => observePiRestartPending(f.state, f.events, "company")).toThrow("Pi native restart");
});

it.each([
  ["no native event", (f: ReturnType<typeof fixture>) => { f.events.length = 0; }],
  ["wrong origin", (f: ReturnType<typeof fixture>) => { f.request.origin.provider = "cursor"; }],
  ["semantic origin", (f: ReturnType<typeof fixture>) => { f.request.origin.adapter = "semantic"; }],
  ["internal kind instead of public schema", (f: ReturnType<typeof fixture>) => { f.request.requestKind = "elicitation"; }],
  ["missing native session", (f: ReturnType<typeof fixture>) => { delete f.state.runs[0]!.nativeSessionId; }],
  ["foreign request turn", (f: ReturnType<typeof fixture>) => { f.request.turnId = "other"; }],
  ["foreign company", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.companyId = "other"; }],
  ["durable fallback", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.continuationPolicy = "wake_assignee"; }],
  ["wrong idempotency identity", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.idempotencyKey = "other"; }],
  ["duplicate interaction", (f: ReturnType<typeof fixture>) => { f.state.interactions.push(structuredClone(f.state.interactions[0]!)); }],
  ["duplicate source receipt", (f: ReturnType<typeof fixture>) => { f.events.push(structuredClone(f.events[0]!)); }],
  ["already answered", (f: ReturnType<typeof fixture>) => { f.finish(); }],
] as const)("rejects %s before restart", (_label, mutate) => {
  const f = fixture(); mutate(f); expect(() => observePiRestartPending(f.state, f.events, "company")).toThrow("Pi native restart");
});

it.each([
  ["replacement run", (f: ReturnType<typeof fixture>) => { f.state.runs[0]!.id = "replacement"; }],
  ["additional run", (f: ReturnType<typeof fixture>) => { f.state.runs.push({ ...f.state.runs[0], id: "replayed" }); }],
  ["replacement native session", (f: ReturnType<typeof fixture>) => { f.state.runs[0]!.nativeSessionId = "replacement"; }],
  ["replacement producer", (f: ReturnType<typeof fixture>) => { f.state.runs[0]!.runnerInstanceId = "replacement"; }],
  ["replaced interaction", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.id = "replacement"; }],
  ["missing resolution", (f: ReturnType<typeof fixture>) => { f.events.splice(1, 1); }],
  ["duplicate resolution", (f: ReturnType<typeof fixture>) => { f.events.push(structuredClone(f.events[1]!)); }],
  ["replayed creation", (f: ReturnType<typeof fixture>) => { f.events.push(f.wrap("runtime_request.created", 4, { request: f.request })); }],
  ["cancelled callback", (f: ReturnType<typeof fixture>) => { f.events[1]!.eventType = f.events[1]!.payload.prpEvent.eventType = "runtime_request.cancelled"; }],
  ["expired callback", (f: ReturnType<typeof fixture>) => { f.events[1]!.eventType = f.events[1]!.payload.prpEvent.eventType = "runtime_request.expired"; }],
  ["wrong delivered answer", (f: ReturnType<typeof fixture>) => { f.events[1]!.payload.prpEvent.payload.response.answers.answer.text = "guess"; }],
  ["wrong durable answer", (f: ReturnType<typeof fixture>) => { f.state.interactions[0]!.result.answers[0].otherText = "guess"; }],
  ["wrong response turn", (f: ReturnType<typeof fixture>) => { f.events[1]!.payload.prpEvent.payload.turnId = "other"; }],
  ["missing resolution envelope turn", (f: ReturnType<typeof fixture>) => { delete f.events[1]!.payload.prpEvent.turnId; }],
  ["missing resolution item", (f: ReturnType<typeof fixture>) => { delete f.events[1]!.payload.prpEvent.itemId; }],
  ["rewritten canonical question", (f: ReturnType<typeof fixture>) => { f.request.input.questions[0]!.prompt = "Replacement prompt"; }],
  ["new native turn", (f: ReturnType<typeof fixture>) => { f.events[2]!.payload.prpEvent.turnId = "other"; }],
  ["failed terminal payload", (f: ReturnType<typeof fixture>) => { f.events[2]!.payload.prpEvent.payload.status = "failed"; }],
  ["missing terminal", (f: ReturnType<typeof fixture>) => { f.events.splice(2, 1); }],
  ["duplicate terminal", (f: ReturnType<typeof fixture>) => { f.events.push(f.wrap("turn.completed", 4, {})); }],
  ["missing control-plane acceptance", (f: ReturnType<typeof fixture>) => { f.events.splice(4, 1); }],
  ["missing control-plane terminal", (f: ReturnType<typeof fixture>) => { f.events.pop(); }],
  ["foreign control-plane source", (f: ReturnType<typeof fixture>) => { f.events[4]!.payload.prpEvent.sourceInstanceId = "other:control"; }],
  ["foreign control-plane turn", (f: ReturnType<typeof fixture>) => { f.events[4]!.payload.prpEvent.turnId = "other"; }],
  ["missing control-plane turn", (f: ReturnType<typeof fixture>) => { delete f.events[4]!.payload.prpEvent.turnId; }],
  ["foreign control-plane session", (f: ReturnType<typeof fixture>) => { f.events[4]!.payload.prpEvent.normalizedSessionId = "other"; }],
  ["mismatched durable control source", (f: ReturnType<typeof fixture>) => { f.events[4]!.sourceSeq = 5; }],
  ["duplicate control receipt", (f: ReturnType<typeof fixture>) => { f.events.push(structuredClone(f.events[4]!)); }],
  ["control plane impersonates a native turn", (f: ReturnType<typeof fixture>) => { f.events.push(f.control("turn.completed", 3, { status: "completed" })); }],
  ["failed control terminal", (f: ReturnType<typeof fixture>) => { f.events[5]!.payload.prpEvent.payload.runTerminalState = "failed"; }],
  ["unaccepted native result", (f: ReturnType<typeof fixture>) => { f.events[4]!.payload.prpEvent.payload.result.summary = "Replacement result"; }],
  ["malformed accepted result", (f: ReturnType<typeof fixture>) => { delete f.events[4]!.payload.prpEvent.payload.result.schema; }],
  ["runner impersonates acceptance", (f: ReturnType<typeof fixture>) => { f.events[4]!.payload.prpEvent.sourceKind = "runner"; }],
] as const)("rejects %s despite a correct workspace answer", (_label, mutate) => {
  const f = fixture(), pending = observePiRestartPending(f.state, f.events, "company"), proof = f.finish();
  mutate(f); expect(() => gradePiRestartCompletion(f.state, f.events, pending, "hidden", proof)).toThrow();
});

it.each([null, {}, { status: "answered", value: "guess" }, { status: "cancelled", value: "hidden" }, { status: "answered", value: "hidden", invented: true }])(
  "rejects missing or wrong independent file proof %j", proof => {
    const f = fixture(), pending = observePiRestartPending(f.state, f.events, "company"); f.finish();
    expect(() => gradePiRestartCompletion(f.state, f.events, pending, "hidden", proof)).toThrow();
  },
);

async function flow(failure?: "replaced" | "wrong-file" | "missing-resolution") {
  const f = fixture(), evidence = new Map<string, any>(), checkpoints: string[] = [];
  let answer = "", restarts = 0, submissions = 0, proof: unknown, resolvePost: ((value: unknown) => void) | undefined;
  let postPredicate: ((value: any) => boolean) | undefined;
  const composer: any = { count: () => 1, filter: () => composer, locator: () => composer, first: () => composer,
    fill: async (value: string) => { expect(restarts).toBe(1); answer = value; } };
  const button: any = { count: () => 1, filter: () => button, click: async () => {
    expect(restarts).toBe(1); expect(answer).toMatch(/^PI-RESTART-[a-f0-9]{32}$/); submissions++;
    const request = { url: () => "http://fixture/api/issues/issue/interactions/interaction/respond", method: () => "POST",
      postDataJSON: () => ({ answers: [{ questionId: "answer", optionIds: [], otherText: answer }] }) };
    expect(postPredicate!(request)).toBe(true); resolvePost!(request); proof = f.finish(answer);
    if (failure === "missing-resolution") f.events.splice(1, 1);
  } };
  const page: any = { getByTestId: () => composer, getByRole: () => button, reload: async () => { checkpoints.push("reload"); },
    waitForRequest: (predicate: (value: any) => boolean) => { postPredicate = predicate; return new Promise(resolve => { resolvePost = resolve; }); } };
  const result = runPiPendingControllerRestart({ page, companyId: "company", deadlineAt: Date.now() + 1000,
    load: async () => structuredClone(f.state), events: async () => structuredClone(f.events),
    restart: async () => {
      expect(submissions).toBe(0); expect(f.state.runs[0]!.status).toBe("running"); expect(f.state.interactions[0]!.status).toBe("pending");
      expect(answer).toBe(""); restarts++; checkpoints.push("restart");
      if (failure === "replaced") f.state.interactions[0]!.id = "replacement";
    },
    settle: async () => structuredClone(f.state), readProof: async () => failure === "wrong-file" ? { status: "answered", value: "guess" } : proof,
    capture: async id => { checkpoints.push(id); }, evidence: async (name, data) => { evidence.set(name, structuredClone(data)); },
  });
  if (failure) await expect(result).rejects.toThrow("Pi native restart");
  else expect((await result).every(check => check.passed)).toBe(true);
  expect(restarts).toBe(1); expect(submissions).toBe(failure === "replaced" ? 0 : 1);
  expect(checkpoints.slice(0, 3)).toEqual(["pi-restart-pending", "restart", "reload"]);
  expect(evidence.has("pi-native-restart-before.json")).toBe(true);
  expect(evidence.has("pi-native-restart-after.json")).toBe(true);
  expect(evidence.has("pi-native-restart-checks.json")).toBe(true);
  expect(JSON.stringify(evidence.get("pi-native-restart-before.json"))).not.toContain("PI-RESTART-");
  if (failure !== "replaced") expect(evidence.has("pi-native-restart-final.json")).toBe(true);
}
it("restarts while unanswered, reloads, then submits hidden text through the exact browser route", () => flow());
it.each(["replaced", "wrong-file", "missing-resolution"] as const)("retains evidence and fails whole flow on %s", failure => flow(failure));

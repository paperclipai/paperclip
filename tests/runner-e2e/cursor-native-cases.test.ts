import { parsePaperclipQuestionResponse } from "../../packages/paperclip-runner/src/contracts/question-set.js";
import { normalizeCursorPlanRequest } from "../../packages/paperclip-runner/src/drivers/acpx/cursor-extensions.js";
import { cursorNativePlanResponse } from "./cursor-native-flow.js";
import { cursorDeniedCommand, type CursorToolNotice } from "./cursor-native-evidence.js";
import { describe, expect, it } from "vitest";
import { cursorNativeCaseDesigns, cursorNativePrompt, hasDeliveredCursorNativeRequest, hasCursorPlanDecision, hasCursorDenialBoundary, CURSOR_DENIAL_SAMPLE_PHASES, hasExactCursorNativeResponse } from "./cursor-native-cases.js";

const proof = () => {
  const wrap = (eventType: string, sourceSeq: number, payload: unknown) => ({ runId: "run", protocolSchemaVersion: 1, payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "run", turnId: "turn", eventType, sourceSeq, payload,
  } } });
  return [wrap("runtime_request.created", 1, { request: { requestId: "request", turnId: "turn", type: "input", status: "pending", origin: { adapter: "acpx-runtime", provider: "cursor", method: "cursor/ask_question" } } }),
    wrap("runtime_request.resolved", 2, { requestId: "request", turnId: "turn", action: "submit" })];
};
const grade = (events: unknown[]) => hasDeliveredCursorNativeRequest({ events, runId: "run", turnId: "turn", requestId: "request", method: "cursor/ask_question", action: "submit" });
describe("prepared Cursor native qualification", () => {
  it("has four fixed native-only designs and bounded prompts", () => {
    expect(cursorNativeCaseDesigns).toHaveLength(4);
    for (const design of cursorNativeCaseDesigns) expect(cursorNativePrompt(design.id, "test-nonce")).toContain("Do not substitute");
    expect(() => cursorNativePrompt("native-write-deny-reconnect", "../escape")).toThrow();
  });
  it("requires correlated native origin and response delivery evidence", () => { expect(grade(proof())).toBe(true); expect(grade([])).toBe(false); });
  it("rejects semantic substitutions and permission fallbacks", () => {
    for (const method of ["request_human_input", "session/request_permission", "cursor/create_plan"]) {
      const rows = proof(); (rows[0]!.payload.prpEvent.payload as any).request.origin.method = method; expect(grade(rows)).toBe(false);
    }
  });
  it("rejects missing, duplicated and expired delivery", () => {
    const rows = proof(); expect(grade(rows.slice(0, 1))).toBe(false); expect(grade([...rows, rows[1]])).toBe(false);
    rows[1]!.payload.prpEvent.eventType = "runtime_request.expired"; expect(grade(rows)).toBe(false);
  });
  it("rejects mismatched run, turn and event ordering", () => {
    let rows = proof(); rows[1]!.runId = "foreign"; expect(grade(rows)).toBe(false);
    rows = proof(); rows[1]!.payload.prpEvent.turnId = "stale"; expect(grade(rows)).toBe(false);
    rows = proof(); rows[1]!.payload.prpEvent.sourceSeq = 0; expect(grade(rows)).toBe(false);
  });
});

it("binds plan decisions to the full revision and rejects stale answers", () => {
  const id = `plan-${"a".repeat(64)}`;
  const questionSet = { questions: [{ id }] };
  const answer = { schema: "paperclip.question_response.v1", answers: { [id]: { selectedOptionIds: ["accept"] } } };
  expect(hasCursorPlanDecision(questionSet, answer, "accept")).toBe(true);
  expect(hasCursorPlanDecision({ questions: [{ id: `plan-${"b".repeat(64)}` }] }, answer, "accept")).toBe(false);
  expect(hasCursorPlanDecision(questionSet, answer, "reject")).toBe(false);
});
it("requires supported denial choices, native IDs and complete no-effect boundaries", () => {
  const input = { request: { requestId: "request", turnId: "turn", type: "permission", status: "pending", details: { toolCallId: "tool" },
    origin: { adapter: "acpx-runtime", provider: "cursor", method: "session/request_permission" },
    choices: [{ key: "accept" }, { key: "decline" }, { key: "cancel" }] }, expectedRequestId: "request", expectedToolCallId: "tool", path: "/fixture/denied.txt", runId: "run", turnId: "turn",
    notices: ([{ stage: "tool", status: "pending" }, { stage: "permission_requested", requestId: "request", declineOffered: true }, { stage: "permission_delivered", requestId: "request", outcome: "reject_once" }, { stage: "tool", status: "failed" }].map((row, index) => ({ ...row, seq: index + 1, runId: "run", sessionId: "session", turnId: "turn", toolCallId: "tool", operation: "execute", commandSha256: cursorDeniedCommand("/fixture/denied.txt").commandSha256 })) as CursorToolNotice[]),
    samples: CURSOR_DENIAL_SAMPLE_PHASES.map((phase, observedAt) => ({ phase, observedAt, absent: true, path: "/fixture/denied.txt" })) };
  expect(hasCursorDenialBoundary(input)).toBe(true);
  expect(hasCursorDenialBoundary({ ...input, samples: input.samples.slice(1) })).toBe(false);
  expect(hasCursorDenialBoundary({ ...input, expectedToolCallId: "foreign" })).toBe(false);
  input.samples[2]!.absent = false; expect(hasCursorDenialBoundary(input)).toBe(false); input.samples[2]!.absent = true;
  input.request.choices.push({ key: "accept_for_session" }); expect(hasCursorDenialBoundary(input)).toBe(false);
});

it("requires exact delivered answer bytes rather than a saved or different answer", () => {
  const rows = proof(); const response = { schema: "paperclip.question_response.v1", answers: { q: { selectedOptionIds: ["chosen"] } } };
  (rows[1]!.payload.prpEvent.payload as any).response = response;
  const input = { events: rows, runId: "run", turnId: "turn", requestId: "request", method: "cursor/ask_question" as const, action: "submit" as const, response };
  expect(hasExactCursorNativeResponse(input)).toBe(true);
  expect(hasExactCursorNativeResponse({ ...input, response: { ...response, answers: { q: { selectedOptionIds: ["other"] } } } })).toBe(false);
  expect(hasExactCursorNativeResponse({ ...input, events: rows.slice(0, 1) })).toBe(false);
});


it.each(["accept", "cancel", "reject"] as const)("recognizes canonical delivered native plan %s without an empty optional answer", decision => {
  const native = normalizeCursorPlanRequest({ toolCallId: "native-plan", plan: "Verify the revised plan.", todos: [] });
  const planId = native.questionSet.questions[0]!.id;
  const response = cursorNativePlanResponse(planId, decision, "  Keep exact feedback 漢字\nSecond line  ");
  const delivered = parsePaperclipQuestionResponse(native.questionSet, response);
  const rows = proof();
  (rows[0]!.payload.prpEvent.payload as any).request.origin.method = "cursor/create_plan";
  (rows[1]!.payload.prpEvent.payload as any).response = delivered;
  const input = { events: rows, runId: "run", turnId: "turn", requestId: "request", method: "cursor/create_plan" as const, action: "submit" as const, response };
  expect(hasCursorPlanDecision(native.questionSet, response, decision)).toBe(true);
  expect(hasExactCursorNativeResponse(input)).toBe(true);
  expect(native.resolve(delivered).outcome.outcome).toBe({ accept: "accepted", cancel: "cancelled", reject: "rejected" }[decision]);
  if (decision === "reject") expect(delivered.answers.reason?.text).toBe("  Keep exact feedback 漢字\nSecond line  ");
  else {
    expect(delivered.answers).not.toHaveProperty("reason");
    expect(hasExactCursorNativeResponse({ ...input, response: { ...response, answers: { ...response.answers, reason: {} } } })).toBe(false);
  }
});

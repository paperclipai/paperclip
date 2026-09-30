import { expect, it } from "vitest";
import { cursorDeniedCommand, hasCursorDeniedCommand, hasCursorCancellation, readCursorToolEvidence, type CursorToolNotice } from "./cursor-native-evidence.js";

export function denialNotices(path = "/fixture/denied.txt"): CursorToolNotice[] {
  const base = { runId: "run", sessionId: "session", turnId: "turn", toolCallId: "tool", operation: "execute", commandSha256: cursorDeniedCommand(path).commandSha256 };
  return [{ ...base, seq: 1, stage: "tool", status: "pending" }, { ...base, seq: 2, stage: "permission_requested", requestId: "request", declineOffered: true },
    { ...base, seq: 3, stage: "permission_delivered", requestId: "request", outcome: "reject_once" }, { ...base, seq: 4, stage: "tool", status: "failed" }];
}
const grade = (notices: CursorToolNotice[]) => hasCursorDeniedCommand({ notices, runId: "run", turnId: "turn", requestId: "request", toolCallId: "tool", commandSha256: cursorDeniedCommand("/fixture/denied.txt").commandSha256 });
it("requires the exact absolute command, native request, delivered denial and failed call in order", () => {
  expect(grade(denialNotices())).toBe(true); expect(grade(denialNotices("/other/denied.txt"))).toBe(false);
  expect(grade(denialNotices().slice(1))).toBe(false); expect(grade([...denialNotices(), denialNotices()[0]!])).toBe(false);
  for (const key of ["runId", "sessionId", "turnId", "toolCallId", "commandSha256"]) {
    const rows = denialNotices(); (rows[3] as any)[key] = "other"; expect(grade(rows)).toBe(false);
  }
  const rows = denialNotices(); rows[3]!.seq = 2; expect(grade(rows)).toBe(false);
});
it("quotes fixture paths and refuses relative or multiline targets", () => {
  expect(cursorDeniedCommand("/fixture/it's here.txt").command).toContain("it'\\''s here.txt");
  expect(() => cursorDeniedCommand("relative")).toThrow(); expect(() => cursorDeniedCommand("/fixture/\ncommand")).toThrow();
});
it("reads only strict public producer-bound evidence and rejects incompleteness", () => {
  const rows = denialNotices().map(n => ({ runId: n.runId, seq: n.seq, protocolSchemaVersion: 1, eventType: "provider.notice.recorded", payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: n.runId, turnId: n.turnId, emittedAt: new Date(1).toISOString(), eventType: "provider.notice.recorded",
    payload: { schema: "paperclip.provider.notice.v1", scope: "turn", category: "cursor_tool_evidence_v1", provenance: { sessionId: n.sessionId, turnId: n.turnId, eventType: n.stage, method: n.stage === "tool" ? "session/update" : "session/request_permission" },
      details: Object.entries(n).filter(([key]) => !["runId", "sessionId", "turnId", "seq"].includes(key)).map(([name, value]) => ({ name, value: String(value) })) },
  } } }));
  expect(grade(readCursorToolEvidence(rows, "run"))).toBe(true);
  const changed = structuredClone(rows); changed[0]!.payload.prpEvent.payload.provenance.turnId = "other";
  expect(() => readCursorToolEvidence(changed, "run")).toThrow();
  const incomplete = structuredClone(rows); incomplete[0]!.payload.prpEvent.payload.details[0] = { name: "stage", value: "evidence_incomplete" };
  expect(() => readCursorToolEvidence(incomplete, "run")).toThrow(/incomplete/);
  expect(() => readCursorToolEvidence([...rows, rows[0]], "run")).toThrow(/Duplicate/);
});
it("requires acknowledged cancellation and an actual correlated terminal after the request", () => {
  const input = { run: { id: "run", status: "cancelled", resultJson: { nativeCancellation: { dispatchState: "acknowledged", dispatched: true, scope: "run" } } }, issue: { status: "in_progress" }, runId: "run", turnId: "turn", requestedAt: 10,
    events: [{ runId: "run", protocolSchemaVersion: 1, payload: { prpEvent: { runId: "run", turnId: "turn", eventType: "turn.cancelled", schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", emittedAt: new Date(11).toISOString() } } }] };
  expect(hasCursorCancellation(input)).toBe(true);
  expect(hasCursorCancellation({ ...input, events: [] })).toBe(false); expect(hasCursorCancellation({ ...input, requestedAt: 12 })).toBe(false);
  expect(hasCursorCancellation({ ...input, issue: { status: "done" } })).toBe(false);
  expect(hasCursorCancellation({ ...input, turnId: "foreign" })).toBe(false);
  input.run.resultJson.nativeCancellation.dispatched = false; expect(hasCursorCancellation(input)).toBe(false);
});

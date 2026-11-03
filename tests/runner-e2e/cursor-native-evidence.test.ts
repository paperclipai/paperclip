import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { cursorDeniedCommand, hasCursorDeniedCommand, hasCursorDeniedTurnTerminal, hasCursorCancellation, readCursorToolEvidence, type CursorToolNotice } from "./cursor-native-evidence.js";

export function denialNotices(path = "/fixture/denied.txt"): CursorToolNotice[] {
  const base = { runId: "run", sessionId: "session", turnId: "turn", toolCallId: "tool", operation: "execute", commandSha256: cursorDeniedCommand(path).commandSha256 };
  return [{ ...base, seq: 1, stage: "tool", status: "pending" }, { ...base, seq: 2, stage: "permission_requested", requestId: "request", declineOffered: true },
    { ...base, seq: 3, stage: "permission_delivered", requestId: "request", outcome: "reject_once" }, { ...base, seq: 4, stage: "tool", status: "failed" }];
}
const grade = (notices: CursorToolNotice[]) => hasCursorDeniedCommand({ notices, runId: "run", turnId: "turn", requestId: "request", toolCallId: "tool", commandSha256: cursorDeniedCommand("/fixture/denied.txt").commandSha256 });
it("requires the exact absolute command, native request, delivered denial and settled call in order", () => {
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

it("requires remote lease identity and actual Linux process retirement, not empty host observations", async () => {
  const { assertCursorRemoteSnapshot, hasCursorRemoteRetirement } = await import("./cursor-native-evidence.js");
  const binding = { companyId: "company", environmentId: "environment", runId: "run", leaseId: "lease", sandboxId: "sandbox", remoteCwd: "/home/daytona/paperclip-workspace", image: `runner@sha256:${"a".repeat(64)}` };
  const root = { pid: 51, startTicks: "3021", bootId: "12345678-1234-1234-1234-123456789abc" };
  const snapshot = { binding, observedAtMs: 50, complete: true, workspace: { "file.txt": `sha256:${"b".repeat(64)}` }, targets: {}, watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 }, processes: { captured: true, root, journal: [{ ...root, ppid: 1 }], live: [] as number[] } };
  expect(() => assertCursorRemoteSnapshot(snapshot, binding)).not.toThrow(); expect(hasCursorRemoteRetirement(snapshot, binding)).toBe(true);
  for (const key of Object.keys(binding)) {
    const changed = { ...binding, [key]: "foreign" }; expect(() => assertCursorRemoteSnapshot({ ...snapshot, binding: changed }, binding)).toThrow(/authority/);
  }
  expect(hasCursorRemoteRetirement({ ...snapshot, processes: { ...snapshot.processes, captured: false } }, binding)).toBe(false);
  expect(hasCursorRemoteRetirement({ ...snapshot, processes: { ...snapshot.processes, live: [51] } }, binding)).toBe(false);
  expect(hasCursorRemoteRetirement({ ...snapshot, processes: { ...snapshot.processes, journal: [{ ...root, ppid: 1, startTicks: "4000" }] } }, binding)).toBe(false);
  expect(() => assertCursorRemoteSnapshot({ ...snapshot, workspace: { "../host-copy": "directory" } }, binding)).toThrow(/workspace/);
  expect(() => assertCursorRemoteSnapshot({ ...snapshot, watcher: { complete: false, targetMutationCount: 0, workspaceMutationCount: 0 } }, binding)).toThrow(/authority/);
});

it("binds remote absent-target samples to stable directory identity and transient-write observation", async () => {
  const { cursorRemoteDeniedSample } = await import("./cursor-native-evidence.js");
  const binding = { companyId: "company", environmentId: "environment", runId: "run", leaseId: "lease", sandboxId: "sandbox", remoteCwd: "/home/daytona/paperclip-workspace", image: `runner@sha256:${"a".repeat(64)}` };
  const target = { absent: true, sha256: null, parent: { dev: "1", ino: "2" }, mutationCount: 0, complete: true };
  const snapshot = { binding, observedAtMs: 50, complete: true, workspace: {}, targets: { "denied.txt": target }, watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 }, processes: { captured: false, root: null, journal: [], live: [] } };
  expect(cursorRemoteDeniedSample(snapshot, binding, "denied.txt", "pending", target.parent)).toMatchObject({ absent: true, path: "/home/daytona/paperclip-workspace/denied.txt", phase: "pending" });
  expect(() => cursorRemoteDeniedSample({ ...snapshot, targets: {} }, binding, "denied.txt", "pending")).toThrow(/incomplete/);
  expect(() => cursorRemoteDeniedSample(snapshot, binding, "denied.txt", "pending", { dev: "1", ino: "3" })).toThrow(/changed/);
  expect(() => cursorRemoteDeniedSample({ ...snapshot, targets: { "denied.txt": { ...target, mutationCount: 2 } } }, binding, "denied.txt", "pending")).toThrow(/changed/);
  expect(() => cursorRemoteDeniedSample(snapshot, binding, "../denied.txt", "pending")).toThrow(/Invalid/);
});

it("rejects transient remote workspace writes even when final hashes match", async () => {
  const { hasCursorRemoteWorkspaceUnchanged } = await import("./cursor-native-evidence.js");
  const binding = { companyId: "company", environmentId: "environment", runId: "run", leaseId: "lease", sandboxId: "sandbox", remoteCwd: "/home/daytona/paperclip-workspace", image: `runner@sha256:${"a".repeat(64)}` };
  const baseline = { binding, observedAtMs: 50, complete: true, workspace: {}, targets: {}, watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 }, processes: { captured: false, root: null, journal: [], live: [] } };
  expect(hasCursorRemoteWorkspaceUnchanged({ ...baseline, observedAtMs: 60 }, baseline)).toBe(true);
  expect(hasCursorRemoteWorkspaceUnchanged({ ...baseline, watcher: { ...baseline.watcher, workspaceMutationCount: 2 } }, baseline)).toBe(false);
  expect(hasCursorRemoteWorkspaceUnchanged({ ...baseline, workspace: { "new-file": `sha256:${"b".repeat(64)}` } }, baseline)).toBe(false);
  expect(hasCursorRemoteWorkspaceUnchanged({ ...baseline, observedAtMs: 40 }, baseline)).toBe(false);
});

it("allows explicit earlier remote bootstrap reads while rejecting unknown kinds and later extra work", () => {
  const rows = denialNotices().map(row => ({ ...row, seq: row.seq + 3 }));
  const read: CursorToolNotice = { ...rows[0]!, seq: 1, toolCallId: "bootstrap-read", stage: "tool", status: "completed", operation: "read", commandSha256: undefined };
  const input = { notices: [read, ...rows], runId: "run", turnId: "turn", requestId: "request", toolCallId: "tool", commandSha256: cursorDeniedCommand("/fixture/denied.txt").commandSha256 };
  expect(hasCursorDeniedCommand(input)).toBe(false);
  const actionFile = `.paperclip-eval-action-${"a".repeat(36)}.txt`;
  const event = { runId: "run", seq: 2, protocolSchemaVersion: 1, eventType: "tool.execution.completed", payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", eventType: "tool.execution.completed", emittedAt: new Date(2).toISOString(),
    payload: { schema: "paperclip.tool.execution.v1", executionId: "bootstrap-read", transport: "builtin", operation: "read", target: actionFile, status: "completed" },
  } } };
  read.readTargetSha256 = `sha256:${createHash("sha256").update(actionFile).digest("hex")}`;
  const bootstrapReadProof = { actionFile, events: [event] };
  expect(hasCursorDeniedCommand({ ...input, bootstrapReadProof })).toBe(true);
  expect(hasCursorDeniedCommand({ ...input, bootstrapReadProof: { actionFile, events: [] } })).toBe(false);
  const wrong = structuredClone(event); wrong.payload.prpEvent.payload.target = "unrelated.txt";
  expect(hasCursorDeniedCommand({ ...input, bootstrapReadProof: { actionFile, events: [wrong] } })).toBe(false);
  const extra = { ...read, toolCallId: "unrelated", seq: 0 };
  expect(hasCursorDeniedCommand({ ...input, notices: [extra, ...input.notices], bootstrapReadProof })).toBe(false);
  for (const operation of [undefined, "edit", "execute"]) expect(hasCursorDeniedCommand({ ...input, bootstrapReadProof, notices: [{ ...read, operation }, ...rows] })).toBe(false);
  expect(hasCursorDeniedCommand({ ...input, bootstrapReadProof, notices: [...rows, { ...read, seq: 20 }] })).toBe(false);
  expect(hasCursorDeniedCommand({ ...input, bootstrapReadProof, notices: [{ ...read, sessionId: "other" }, ...rows] })).toBe(false);
});

it("accepts Cursor's transport-completed denial only with the exact delivered rejection", () => {
  const rows = denialNotices(); rows[3]!.status = "completed";
  expect(grade(rows)).toBe(true);
  expect(grade(rows.filter(row => row.stage !== "permission_delivered"))).toBe(false);
  for (const outcome of ["allow_once", "allow_always", "cancel"]) {
    const changed = structuredClone(rows); changed[2]!.outcome = outcome; expect(grade(changed)).toBe(false);
  }
  expect(grade([...rows, { ...rows[3]!, seq: 5 }])).toBe(false);
  expect(grade([...rows, { ...rows[0]!, seq: 5, toolCallId: "replayed-write" }])).toBe(false);
});
it("requires a correlated failed semantic finalization after the delivered denial, never false success", () => {
  const evidence = { runId: "run", seq: 3, protocolSchemaVersion: 1, eventType: "provider.notice.recorded", payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", emittedAt: new Date(1).toISOString(), eventType: "provider.notice.recorded",
    payload: { schema: "paperclip.provider.notice.v1", scope: "turn", category: "cursor_tool_evidence_v1", provenance: { sessionId: "session", turnId: "turn", eventType: "permission_delivered", method: "session/request_permission" },
      details: [{ name: "stage", value: "permission_delivered" }, { name: "toolCallId", value: "tool" }, { name: "requestId", value: "request" }, { name: "outcome", value: "reject_once" }] },
  } } };
  const terminal = { runId: "run", seq: 5, protocolSchemaVersion: 1, eventType: "turn.completed", payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", emittedAt: new Date(2).toISOString(), eventType: "turn.completed", payload: { status: "completed", error: null },
  } } };
  const input = { runId: "run", turnId: "turn", requestId: "request", issue: { id: "issue", status: "in_progress" },
    run: { id: "run", nativeIssueId: "issue", runtimeMode: "native", status: "failed", errorCode: "native_session_interrupted", error: "native_finalization_missing: session returned no semantic result" }, events: [evidence, terminal] };
  expect(hasCursorDeniedTurnTerminal(input)).toBe(true);
  const declined = { ...input, issue: { ...input.issue, status: "blocked" }, run: { ...input.run, errorCode: "native_permission_declined", error: "native_finalization_missing: session returned no semantic result; provider permission was declined; explicit direction is required" } };
  expect(hasCursorDeniedTurnTerminal(declined)).toBe(true);
  expect(hasCursorDeniedTurnTerminal({ ...declined, run: { ...declined.run, error: declined.run.error.replace("provider permission", "Cursor permission") } })).toBe(true);
  expect(hasCursorDeniedTurnTerminal({ ...declined, run: { ...declined.run, error: "unrelated failure" } })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...declined, issue: { ...declined.issue, status: "done" } })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...declined, events: [terminal] })).toBe(false);
  for (const status of ["succeeded", "cancelled", "timed_out", "running"]) expect(hasCursorDeniedTurnTerminal({ ...input, run: { ...input.run, status } })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, issue: { ...input.issue, status: "done" } })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, run: { ...input.run, errorCode: "other" } })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, run: { ...input.run, nativeIssueId: "foreign" } })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, events: [terminal] })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, events: [evidence, terminal, terminal] })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, turnId: "foreign" })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, requestId: "foreign" })).toBe(false);
  expect(hasCursorDeniedTurnTerminal({ ...input, events: [evidence, { ...terminal, seq: 2 }] })).toBe(false);
});

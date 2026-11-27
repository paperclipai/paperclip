import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copilotEditOriginForPermission, readCopilotToolEvidence } from "./copilot-evidence.js";
import { observeActiveStopPending, readActiveStopCaller } from "./copilot-active-stop-evidence.js";
const retained = JSON.parse(readFileSync(new URL("./fixtures/copilot-patch-permission-target-v15.json", import.meta.url), "utf8"));
const caller = readActiveStopCaller({ deploymentMode: "local_trusted" }, { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } });
function fixture() {
  const { rows: events, scope, run, issue } = structuredClone(retained);
  const notices = readCopilotToolEvidence(events, run.id);
  const read = () => observeActiveStopPending({ events, scope, run, issue, caller, cancellationRequestId: "11111111-2222-4333-8444-555555555555" });
  return { events, scope, notices, read };
}
describe("pending patch target bound by its exact permission", () => {
  it("calibrates the retained missing-notification path while keeping the actual card target", () => {
    const f = fixture(), origin = copilotEditOriginForPermission(f.notices, f.scope.target)!;
    expect(origin.target).toBeUndefined();
    expect(origin.toolCallId).toBe("custom_call_jyQm34Kq61JjSxkZUXvPSNrh");
    expect(f.read()).toMatchObject({ toolCallId: origin.toolCallId, scope: { target: f.scope.target }, requestId: "acpx-input-ccaa35c8d2130be28a27e1d3" });
    expect(retained.outcome).toContain("calibration only");
  });
  it.each(["wrong-call", "foreign-session", "foreign-turn", "foreign-run", "conflicting-path", "conflicting-operation", "duplicate-pending", "duplicate-permission", "missing-permission"])("refuses %s", kind => {
    const f = fixture();
    const origin = copilotEditOriginForPermission(f.notices, f.scope.target)!;
    const permission = f.notices.find(n => n.stage === "permission_requested" && n.toolCallId === origin.toolCallId)!;
    if (kind === "wrong-call") permission.toolCallId = "unrelated";
    if (kind === "foreign-session") permission.sessionId = "foreign";
    if (kind === "foreign-turn") permission.turnId = "foreign";
    if (kind === "foreign-run") permission.runId = "foreign";
    if (kind === "conflicting-path") origin.target = "another.txt";
    if (kind === "conflicting-operation") origin.operation = "execute";
    if (kind === "duplicate-pending") f.notices.push({ ...origin, seq: origin.seq + 1 });
    if (kind === "duplicate-permission") f.notices.push({ ...permission, seq: permission.seq + 1 });
    if (kind === "missing-permission") f.notices.splice(f.notices.indexOf(permission), 1);
    if (["wrong-call", "missing-permission"].includes(kind)) expect(copilotEditOriginForPermission(f.notices, f.scope.target)).toBeUndefined();
    else expect(() => copilotEditOriginForPermission(f.notices, f.scope.target)).toThrow(/Copilot.*(?:origin|target)/);
  });
  it("cannot borrow a target from another native operation", () => {
    const f = fixture();
    expect(copilotEditOriginForPermission(f.notices, f.scope.target, "other-call")).toBeUndefined();
  });
  it.each(["card-call", "card-request", "card-source", "wrong-provider", "wrong-adapter", "wrong-method", "permission-path", "context-after-edit"])("keeps durable evidence guard for %s", kind => {
    const f = fixture();
    const row = (eventType: string, seq: number) => f.events.find((r: any) => r.eventType === eventType && r.seq === seq);
    const payload = (r: any) => r.payload.prpEvent.payload;
    if (kind === "card-call") payload(row("runtime_request.created", 134)).request.details.toolCallId = "other-call";
    if (kind === "card-request") payload(row("runtime_request.created", 134)).request.requestId = "other-request";
    if (kind === "wrong-provider") payload(row("runtime_request.created", 134)).request.origin.provider = "cursor";
    if (kind === "wrong-adapter") payload(row("runtime_request.created", 134)).request.origin.adapter = "untrusted";
    if (kind === "wrong-method") payload(row("runtime_request.created", 134)).request.origin.method = "other";
    if (kind === "card-source") row("runtime_request.created", 134).payload.prpEvent.sourceInstanceId = "other-source";
    if (kind === "permission-path") payload(row("provider.notice.recorded", 137)).details.find((d: any) => d.name === "target").value = "other.txt";
    if (kind === "context-after-edit") row("tool.execution.completed", 130).seq = 136;
    expect(f.read).toThrow();
  });
});

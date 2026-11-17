import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { approvePiBootstrapRead, withoutApprovedPiBootstrapRequests, type PiBootstrapApproval } from "./pi-bootstrap-permission.js";
import { observePiControlPending, readPiStopSettlement, readPiSteeringSettlement } from "./pi-controls-evidence.js";
import { piCancellationId, piControlCaller, piControlFixture } from "./pi-controls-test-fixture.js";
const actionFile = `.paperclip-eval-action-${"a".repeat(36)}.txt`;
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
function fixture() {
  const f = piControlFixture(), write = structuredClone(f.events);
  f.events.length = 0;
  const read = { schema: "paperclip.tool.execution.v1", transport: "builtin", executionId: "setup-tool", name: "read", operation: "read", target: actionFile, status: "running" };
  const request = { ...f.request, requestId: "setup-request", itemId: "setup-item", details: { toolCallId: "setup-tool" }, choices: [{ key: "accept", label: "Allow once" }, { key: "decline", label: "Deny" }] };
  f.append("tool.execution.started", read); f.append("runtime_request.created", { request });
  const finish = () => {
    f.append("runtime_request.resolved", { requestId: request.requestId, turnId: "turn", action: "accept" });
    f.append("tool.execution.completed", { ...read, status: "completed" });
    for (const row of write) f.append(row.eventType, row.payload.prpEvent.payload);
  };
  const proof = (): PiBootstrapApproval => ({ schema: "paperclip.e2e.pi-bootstrap-read-approval.v1", companyId: f.scope.companyId, issueId: f.scope.issueId, runId: f.scope.runId, actionFile, publishedSha256: `sha256:${"b".repeat(64)}`,
    requestId: "setup-request", toolCallId: "setup-tool", turnId: "turn", normalizedSessionId: "session", sourceInstanceId: "source",
    createdRowSha256: digest(f.events[1]), resolvedRowSha256: digest(f.events[2]), completedRowSha256: digest(f.events[3]) });
  return { ...f, read, finish, proof };
}

describe("Pi operator setup read", () => {
  it("approves only the published owned file through the exact public request", async () => {
    const f = fixture(), saved = new Map<string, unknown>(); let posts = 0;
    const result = await approvePiBootstrapRead({
      api: { post: async (path: string, data: unknown) => { expect(path).toBe("/api/heartbeat-runs/run/runtime-requests/setup-request/resolve"); expect(data).toEqual({ turnId: "turn", requestKind: "permission_approval", resolution: { action: "accept" } }); posts++; f.finish(); } } as any,
      fixture: { actionFile, binding: { companyId: "company", runId: "run" }, snapshot: async () => ({ complete: true, setup: { path: actionFile, published: true, sha256: `sha256:${"b".repeat(64)}` } }) } as any,
      companyId: "company", issueId: "issue", runId: "run", deadlineAt: Date.now() + 2000, load: async () => f.state(), evidence: async (name, value) => { saved.set(name, value); },
    });
    expect(posts).toBe(1); expect(result).toEqual(f.proof()); expect(saved.has("pi-bootstrap-read-before-approval.json")).toBe(true);
    const pending = observePiControlPending({ ...f.state(), scope: f.scope, bootstrapApproval: result });
    expect(pending.requestId).toBe("request"); expect(pending.bootstrapApproval).toEqual(result);
  });

  it.each(["unpublished", "foreign-binding", "other-file", "shell"])("does not approve %s setup", async failure => {
    const f = fixture(); let posts = 0;
    if (failure === "other-file") f.events[0]!.payload.prpEvent.payload.target = "private.txt";
    if (failure === "shell") { f.events[0]!.payload.prpEvent.payload.name = "bash"; f.events[0]!.payload.prpEvent.payload.operation = "execute"; }
    await expect(approvePiBootstrapRead({ api: { post: async () => { posts++; } } as any,
      fixture: { actionFile, binding: { companyId: failure === "foreign-binding" ? "other" : "company", runId: "run" }, snapshot: async () => ({ complete: true, setup: { path: actionFile, published: failure !== "unpublished", sha256: `sha256:${"b".repeat(64)}` } }) } as any,
      companyId: "company", issueId: "issue", runId: "run", deadlineAt: Date.now() + 2000, load: async () => f.state(), evidence: async () => {},
    })).rejects.toThrow("Pi bootstrap"); expect(posts).toBe(0);
  });

  it.each(["stop", "steering"])("retains the original %s assertions after a proven setup read", mode => {
    const f = fixture(); f.finish(); const proof = f.proof();
    expect(() => observePiControlPending({ ...f.state(), scope: f.scope })).toThrow("one native permission");
    const pending = observePiControlPending({ ...f.state(), scope: f.scope, bootstrapApproval: proof });
    if (mode === "stop") { f.cancel(); expect(readPiStopSettlement({ ...f.state(), pending, caller: piControlCaller, cancellationRequestId: piCancellationId, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() }).normalCompletionAccepted).toBe(false); }
    else { f.steer();
      // The wrapper's setup finish is separate from the original write finish.
      f.append("runtime_request.resolved", { requestId: "request", turnId: "turn", action: "decline" });
      f.append("tool.execution.completed", { ...f.tool, status: "failed", output: "Pi operation was denied or cancelled" });
      f.append("turn.completed", { status: "completed", error: null }); f.run.status = "succeeded"; f.issue.status = "done";
      f.append("run.result.accepted", { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: f.marker } }, { sourceKind: "control_plane", sourceInstanceId: "source:control", sourceSeq: 1, sourceEventId: "source:control:run:1" });
      f.append("run.terminal", { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" }, { sourceKind: "control_plane", sourceInstanceId: "source:control", sourceSeq: 2, sourceEventId: "source:control:run:2" });
      expect(readPiSteeringSettlement({ ...f.state(), pending, commentId: f.commentId, queueId: f.queueId, marker: f.marker, finalMessage: f.marker }).marker).toBe(f.marker);
    }
  });

  it.each(["changed-receipt", "wrong-path", "failed-read", "extra-permission", "reordered", "allow-always"])("rejects %s before excluding setup records", failure => {
    const f = fixture(); f.finish(); const proof = f.proof();
    if (failure === "changed-receipt") proof.resolvedRowSha256 = `sha256:${"0".repeat(64)}`;
    if (failure === "wrong-path") f.events[0]!.payload.prpEvent.payload.target = "other.txt";
    if (failure === "failed-read") f.events[3]!.payload.prpEvent.payload.status = "failed";
    if (failure === "extra-permission") f.append("runtime_request.created", { request: { ...f.request, requestId: "extra" } });
    if (failure === "reordered") f.events[3]!.seq = 1;
    if (failure === "allow-always") f.events[2]!.payload.prpEvent.payload.action = "accept_always";
    expect(() => observePiControlPending({ ...f.state(), scope: f.scope, bootstrapApproval: proof })).toThrow();
  });
  it("does not discard any native lifecycle row", () => { const f = fixture(); f.finish(); const rows = withoutApprovedPiBootstrapRequests(f.events, f.proof()); expect(rows).toHaveLength(f.events.length - 2); expect(rows.filter((row: any) => row.eventType.startsWith("tool.execution."))).toHaveLength(3); });
});

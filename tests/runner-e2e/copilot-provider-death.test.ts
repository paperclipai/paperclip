import { createHash } from "node:crypto";
import { bootstrapReadExecutionId } from "./native-bootstrap-read-proof.js";
import { describe, expect, it } from "vitest";
import { canonicalRemoteCopilotCommand, copilotDeathArguments, selectOwnedCopilotProcess } from "./copilot-provider-death.js";

describe("owned Copilot provider death selector", () => {
  const root = { pid: 10, parent: 1 }, sidecar = { pid: 11, parent: 10 }, native = { pid: 12, parent: 11 };
  const argv = ["/private/paperclip-acpx-native-owned/distribution/copilot", ...copilotDeathArguments];
  it("selects only the native child of the live owned run", () => {
    expect(selectOwnedCopilotProcess(10, [root, sidecar, native], [10, 11, 12], new Map([[12, argv]]))).toEqual(native);
  });
  it.each([3, 7])("recognizes a verified inherited Linux descriptor %i", fd => {
    const command = [`/proc/self/fd/${fd}`, ...copilotDeathArguments];
    const canonical = canonicalRemoteCopilotCommand(command, argv[0]!, { dev: "1", ino: "2" }, { path: argv[0]!, dev: "1", ino: "2" });
    expect(selectOwnedCopilotProcess(10, [root, sidecar, native], [10, 11, 12], new Map([[12, canonical]]))).toEqual(native);
  });
  it("refuses descriptor aliases without matching executable identity", () => {
    for (const [command, executable, descriptor] of [
      [["/proc/self/fd/8", ...copilotDeathArguments], argv[0], { path: argv[0], dev: "1", ino: "2" }],
      [["/proc/self/fd/7", ...copilotDeathArguments], "/usr/bin/copilot", { path: "/usr/bin/copilot", dev: "1", ino: "2" }],
      [["/proc/self/fd/7", ...copilotDeathArguments], argv[0], undefined],
      [["/proc/self/fd/7", ...copilotDeathArguments], argv[0], { path: "/foreign/copilot", dev: "1", ino: "2" }],
      [["/proc/self/fd/7", ...copilotDeathArguments], argv[0], { path: argv[0], dev: "2", ino: "2" }],
      [["/proc/self/fd/7", ...copilotDeathArguments], argv[0], { path: argv[0], dev: "1", ino: "3" }],
    ] as const) {
      const canonical = canonicalRemoteCopilotCommand(command, executable!, { dev: "1", ino: "2" }, descriptor as any);
      expect(() => selectOwnedCopilotProcess(10, [root, sidecar, native], [10, 11, 12], new Map([[12, canonical]]))).toThrow();
    }
  });
  it("refuses foreign, retired, ambiguous and caller-selected processes", () => {
    const commands = new Map([[12, argv]]);
    expect(() => selectOwnedCopilotProcess(10, [root, sidecar, { ...native, parent: 99 }], [10, 11, 12], commands)).toThrow();
    expect(() => selectOwnedCopilotProcess(10, [root, sidecar, native], [11, 12], commands)).toThrow();
    expect(() => selectOwnedCopilotProcess(10, [root, sidecar, native], [10, 11], commands)).toThrow();
    expect(() => selectOwnedCopilotProcess(10, [root, sidecar, native, { pid: 13, parent: 11 }], [10, 11, 12, 13], new Map([[12, argv], [13, argv]]))).toThrow();
    for (const invalid of [["/usr/bin/copilot", ...copilotDeathArguments], [...argv, "--allow-all"], [argv[0]!, "--acp"]]) expect(() => selectOwnedCopilotProcess(10, [root, sidecar, native], [10, 11, 12], new Map([[12, invalid]]))).toThrow();
  });
});

import { assertCopilotProviderDeath } from "./copilot-provider-death.js";
import type { ActiveStopPending } from "./copilot-active-stop-evidence.js";

describe("provider-death independent evidence", () => {
  const pending = { scope: { companyId: "company", runId: "run", issueId: "issue", provider: "copilot", target: "target.txt" }, requestId: "request", toolCallId: "tool", turnId: "turn", normalizedSessionId: "session" } as ActiveStopPending;
  const row = (seq: number, eventType: string, payload: Record<string, unknown>) => ({ companyId: "company", runId: "run", seq, eventType, protocolSchemaVersion: 1, payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn", normalizedSessionId: "session", sourceInstanceId: "source", sourceSeq: seq, sourceEventId: `source:run:${seq}`, emittedAt: "2026-10-03T00:00:00Z", payload } } });
  const notice = row(1, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", scope: "turn", category: "copilot_tool_evidence_v1", provenance: { sessionId: "native-session", turnId: "turn", eventType: "permission_requested", method: "session/request_permission" }, details: Object.entries({ stage: "permission_requested", toolCallId: "tool", requestId: "request", operation: "edit", target: "target.txt", declineOffered: "true" }).map(([name, value]) => ({ name, value })) });
  const facts = () => ({ pending, run: { id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "failed" }, issue: { id: "issue", status: "blocked" }, events: [notice, row(2, "runtime_request.expired", { requestId: "request", turnId: "turn", requestKind: "permission_approval", reason: "provider_exit" }), row(3, "turn.failed", { error: { code: "AGENT_DISCONNECTED", message: "Provider exited" } })] });
  it("accepts callback expiry and an unfinished failed task with no replay", () => {
    expect(assertCopilotProviderDeath(facts())).toMatchObject({ expired: true, mutationReplay: false });
  });
  it("exempts only an exactly attested completed remote instruction-file read", () => {
    const actionFile = `.paperclip-eval-action-${"a".repeat(36)}.txt`, toolCallId = "instruction-read";
    const native = (seq: number, status: string) => row(seq, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", scope: "turn", category: "copilot_tool_evidence_v1", provenance: { sessionId: "native-session", turnId: "turn", eventType: "tool", method: "session/update" }, details: Object.entries({ stage: "tool", toolCallId, operation: "read", status, readTargetSha256: `sha256:${createHash("sha256").update(actionFile).digest("hex")}` }).map(([name, value]) => ({ name, value })) });
    const canonical = (seq: number, eventType: string, status: string) => row(seq, eventType, { schema: "paperclip.tool.execution.v1", transport: "builtin", operation: "read", target: actionFile, executionId: bootstrapReadExecutionId(toolCallId), status });
    const state = facts();
    const edit = row(5, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", scope: "turn", category: "copilot_tool_evidence_v1", provenance: { sessionId: "native-session", turnId: "turn", eventType: "tool", method: "session/update" }, details: Object.entries({ stage: "tool", toolCallId: pending.toolCallId, operation: "edit", status: "pending" }).map(([name, value]) => ({ name, value })) });
    state.events = [native(1, "pending"), canonical(2, "tool.execution.started", "running"), native(3, "completed"), canonical(4, "tool.execution.completed", "completed"), edit, row(6, notice.eventType, notice.payload.prpEvent.payload), row(7, "runtime_request.expired", { requestId: "request", turnId: "turn", requestKind: "permission_approval", reason: "provider_exit" }), row(8, "turn.failed", { error: { code: "AGENT_DISCONNECTED", message: "Provider exited" } })];
    expect(assertCopilotProviderDeath({ ...state, bootstrap: { actionFile, events: state.events } })).toMatchObject({ expired: true });
    expect(() => assertCopilotProviderDeath(state)).toThrow(/operation/);
    expect(() => assertCopilotProviderDeath({ ...state, bootstrap: { actionFile: actionFile.replace("a", "b"), events: state.events } })).toThrow(/bootstrap read/);
  });
  it.each(["execute", "read", "edit"])("refuses an additional %s operation after provider death", operation => {
    const replay = facts();
    const extra = row(4, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", scope: "turn", category: "copilot_tool_evidence_v1", provenance: { sessionId: "native-session", turnId: "turn", eventType: "tool", method: "session/update" }, details: Object.entries({ stage: "tool", toolCallId: "extra-tool", operation, status: "completed" }).map(([name, value]) => ({ name, value })) });
    replay.events.push(extra);
    expect(() => assertCopilotProviderDeath(replay)).toThrow(/replayed or completed an operation/);
  });
  it("refuses an additional semantic operation without a file mutation", () => {
    const replay = facts();
    replay.events.push(row(4, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", scope: "turn", category: "copilot_tool_evidence_v1", provenance: { sessionId: "native-session", turnId: "turn", eventType: "tool", method: "session/update" }, details: Object.entries({ stage: "tool", toolCallId: "semantic-extra", status: "completed", semanticOperationId: "issue.get", semanticCallIdentitySha256: "a".repeat(64), semanticInputSha256: "b".repeat(64), semanticNormalizedInputSha256: "null", semanticResultSha256: "c".repeat(64), semanticOutcome: "returned" }).map(([name, value]) => ({ name, value })) }));
    expect(() => assertCopilotProviderDeath(replay)).toThrow(/replayed or completed an operation/);
  });
  it("refuses missing expiry, stale resolution, success and foreign evidence", () => {
    const missing = facts(); missing.events.splice(1, 1); expect(() => assertCopilotProviderDeath(missing)).toThrow();
    const resolved = facts(); resolved.events.push(row(4, "runtime_request.resolved", { requestId: "request" })); expect(() => assertCopilotProviderDeath(resolved)).toThrow();
    const succeeded = facts(); succeeded.run.status = "succeeded"; expect(() => assertCopilotProviderDeath(succeeded)).toThrow();
    const done = facts(); done.issue.status = "done"; expect(() => assertCopilotProviderDeath(done)).toThrow();
    const foreign = facts(); foreign.events[0]!.companyId = "foreign"; expect(() => assertCopilotProviderDeath(foreign)).toThrow();
  });
});

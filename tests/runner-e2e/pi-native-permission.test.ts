import { expect, it } from "vitest";
import { hasDeliveredPiDenial, piPermissionRequests } from "./pi-native-evidence.js";
const identity = { runId: "run", turnId: "turn", requestId: "permission", toolCallId: "pi-tool-1", target: "pi-human-denied.txt" };
function evidence(adapter = "acpx-runtime") {
  const wrap = (eventType: string, seq: number, payload: unknown) => ({ runId: "run", protocolSchemaVersion: 1, eventType, seq, payload: { prpEvent: {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", eventType, payload,
  } } });
  return [wrap("runtime_request.created", 1, { request: { requestId: "permission", turnId: "turn", type: "permission", status: "pending", details: { toolCallId: "pi-tool-1" },
    origin: { adapter, provider: "pi", method: "session/request_permission" }, choices: [{ key: "decline" }] } }),
  wrap("runtime_request.resolved", 2, { requestId: "permission", turnId: "turn", action: "decline" }),
  wrap("tool.execution.completed", 3, { schema: "paperclip.tool.execution.v1", executionId: "pi-tool-1", transport: "builtin", operation: "edit", name: "write", status: "failed", target: identity.target, output: "Pi operation was denied or cancelled" })];
}
it("requires the actual correlated durable browser denial and native tool failure", () => {
  expect(piPermissionRequests(evidence(), "run")).toHaveLength(1);
  expect(hasDeliveredPiDenial(evidence(), identity)).toBe(true);
  for (const rows of [[], evidence().slice(1), evidence().slice(0, 2), [...evidence(), evidence()[2]!]]) expect(hasDeliveredPiDenial(rows, identity)).toBe(false);
});
it("rejects foreign identities, approvals, expiration, write success and policy-only failure", () => {
  for (const key of ["runId", "turnId", "requestId", "toolCallId", "target"]) expect(hasDeliveredPiDenial(evidence(), { ...identity, [key]: "other" })).toBe(false);
  for (const [index, patch] of [[1, { action: "accept" }], [2, { status: "completed" }], [2, { output: "outside its assigned workspace" }], [2, { executionId: "other" }], [2, { target: "other.txt" }]] as const) {
    const rows = evidence(); Object.assign(rows[index]!.payload.prpEvent.payload as object, patch); expect(hasDeliveredPiDenial(rows, identity)).toBe(false);
  }
  for (const eventType of ["runtime_request.expired", "runtime_request.cancelled"]) {
    const rows = evidence(); rows[1]!.eventType = eventType; rows[1]!.payload.prpEvent.eventType = eventType;
    expect(hasDeliveredPiDenial(rows, identity)).toBe(false);
  }
  const malformed = evidence(); (malformed[0]!.payload.prpEvent.payload as any).request.choices = [null, {}];
  expect(piPermissionRequests(malformed, "run")).toEqual([]);
  const stale = evidence(); stale[1]!.seq = 0; expect(hasDeliveredPiDenial(stale, identity)).toBe(false);
  const wrong = evidence(); wrong[2]!.payload.prpEvent.sourceKind = "agent"; expect(hasDeliveredPiDenial(wrong, identity)).toBe(false);
});
it("does not misorder native notifications that arrive before the public delivery receipt is persisted", () => {
  const rows = evidence(); rows[1]!.seq = 3; rows[2]!.seq = 2;
  // Both native failed invocation and post-write delivery receipt are required;
  // asynchronous persistence order is not treated as native execution order.
  expect(hasDeliveredPiDenial(rows, identity)).toBe(true);
});

import { hasPiRemoteRetirement, hasUnchangedPiRemoteTarget } from "./pi-native-evidence.js";
it("remote denial requires complete watching, stable parent and real process retirement before lease deletion", () => {
  const root = { pid: 12, startTicks: "100", bootId: "boot" };
  const before = { observedAtMs: 1, complete: true, targets: { denied: { absent: true, sha256: null, parent: { dev: "1", ino: "2" }, mutationCount: 0, complete: true } } };
  const after = { ...structuredClone(before), observedAtMs: 2, watcher: { complete: true }, processes: { captured: true, root, journal: [root], live: [] as number[] } };
  expect(hasUnchangedPiRemoteTarget(before, after, "denied")).toBe(true);
  for (const broken of [{ ...after, complete: false }, { ...after, processes: { ...after.processes, live: [12] } }, { ...after, processes: { ...after.processes, captured: false } }, { ...after, processes: { ...after.processes, journal: [] } }, { ...after, watcher: { complete: false } }]) expect(hasUnchangedPiRemoteTarget(before, broken, "denied")).toBe(false);
  for (const change of [{ mutationCount: 1 }, { absent: false }, { parent: { dev: "1", ino: "3" } }, { complete: false }]) {
    expect(hasUnchangedPiRemoteTarget(before, { ...after, targets: { denied: { ...after.targets.denied, ...change } } }, "denied")).toBe(false);
  }
  expect(hasPiRemoteRetirement({ sandboxDeleted: true })).toBe(false);
  expect(hasPiRemoteRetirement({ ...after, watcher: { complete: false } })).toBe(false);
  const existing = structuredClone(before); existing.targets.denied.absent = false; (existing.targets.denied as any).sha256 = `sha256:${"a".repeat(64)}`;
  expect(hasUnchangedPiRemoteTarget(existing, { ...after, targets: existing.targets }, "denied")).toBe(true);
});

it.each(["acpx-runtime", "acpx-runtime-sidecar"])("requires exact Pi permission origin and identity via %s", adapter => {
  expect(piPermissionRequests(evidence(adapter), "run")).toHaveLength(1);
  expect(hasDeliveredPiDenial(evidence(adapter), identity)).toBe(true);
  for (const patch of [{ adapter: "unknown" }, { adapter: "acpx-runtime-sidecar-unknown" }, { adapter: "semantic" }, { provider: "cursor" }, { method: "request_human_input" }]) {
    const rows = evidence(adapter);
    Object.assign((rows[0]!.payload.prpEvent.payload as any).request.origin, patch);
    expect(piPermissionRequests(rows, "run")).toHaveLength(0);
    expect(hasDeliveredPiDenial(rows, identity)).toBe(false);
  }
  for (const key of ["runId", "turnId", "requestId", "toolCallId", "target"]) {
    expect(hasDeliveredPiDenial(evidence(adapter), { ...identity, [key]: "foreign" })).toBe(false);
  }
  const rows = evidence(adapter);
  expect(hasDeliveredPiDenial([...rows, rows[0]!], identity)).toBe(false);
  expect(hasDeliveredPiDenial([...rows, rows[1]!], identity)).toBe(false);
});

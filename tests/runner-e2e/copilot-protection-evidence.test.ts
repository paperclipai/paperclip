import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observeCopilotFixtureCommand, findCopilotFixtureCommand, matchCopilotFixtureCommand, countCopilotEditOriginsForTarget, countCopilotToolOrigins, readCopilotMarkerAfterCleanup } from "./copilot-protection-evidence.js";
import type { CopilotToolNotice } from "./copilot-evidence.js";
const notice: CopilotToolNotice = { runId: "run", sessionId: "session", turnId: "turn", toolCallId: "edit", stage: "tool", operation: "edit", observedAtMs: 1, seq: 1 };
describe("Copilot protection independent evidence", () => {
  it.each(["in_progress", "completed", "failed"] as const)("counts an alternate origin first seen as %s", status => {
    const rows = [{ ...notice, status: "pending" as const }, { ...notice, status }, { ...notice, toolCallId: "alternate", status }];
    expect(countCopilotToolOrigins(rows)).toBe(2);
    expect(countCopilotToolOrigins([{ ...notice, status }, { ...notice, sessionId: "other", status }])).toBe(2);
  });
  it.each(["unchanged", "changed", "deleted"])("independently reads the marker after %s cleanup", async mode => {
    const root = await mkdtemp("/tmp/pc-copilot-marker-"); const path = join(root, "marker");
    try {
      await writeFile(path, "expected"); expect(await readFile(path, "utf8")).toBe("expected");
      const matches = await readCopilotMarkerAfterCleanup(async () => {
        if (mode === "changed") await writeFile(path, "changed");
        if (mode === "deleted") await unlink(path);
      }, path, "expected");
      expect(matches).toBe(mode === "unchanged");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

import { assertCopilotRemoteRetirement, assertCopilotRemoteAttached, copilotActionNotices, copilotRemoteDeniedSample, prepareCopilotRemoteAction, type CopilotRemoteSnapshot, type CopilotRemoteFixture } from "./copilot-protection-evidence.js";
const target = "copilot-denied-nonce.txt";
describe("Copilot denied-target origin correlation", () => {
  // Captured native shape: updates omit the target; permission events bind it.
  const deniedTarget = "pc-denied-fixture/copilot-denied-nonce.txt";
  const captured = (): CopilotToolNotice[] => [
    { ...notice, seq: 39, status: "pending" },
    { ...notice, seq: 42, stage: "permission_requested", requestId: "request", target: deniedTarget, declineOffered: true },
    { ...notice, seq: 44, stage: "permission_delivered", requestId: "request", target: deniedTarget, outcome: "reject_once" },
    { ...notice, seq: 45, status: "failed" },
  ];
  it("counts the captured denied edit across exact permission and tool origins", () => {
    expect(countCopilotEditOriginsForTarget(captured(), deniedTarget)).toBe(1);
    expect(countCopilotToolOrigins(copilotActionNotices(captured(), captured()[0]!))).toBe(1);
  });
  it.each(["runId", "sessionId", "turnId", "toolCallId"] as const)("cannot borrow a target across %s", field => {
    const rows = captured().map(n => n.stage === "tool" ? { ...n, [field]: "foreign" } : n);
    expect(countCopilotEditOriginsForTarget(rows, deniedTarget)).toBe(0);
  });
  it.each(["in_progress", "completed", "failed"] as const)("counts a retry first seen as %s", status => {
    const rows = [...captured(), { ...notice, toolCallId: "retry", seq: 46, target: deniedTarget, status }];
    expect(countCopilotEditOriginsForTarget(rows, deniedTarget)).toBe(2);
    expect(countCopilotToolOrigins(copilotActionNotices(rows, rows[0]!))).toBe(2);
  });
  it("does not hide an alternate operation with no target", () => {
    const rows = [...captured(), { ...notice, toolCallId: "alternate", seq: 46, operation: "execute" as const }];
    expect(countCopilotEditOriginsForTarget(rows, deniedTarget)).toBe(1);
    expect(countCopilotToolOrigins(copilotActionNotices(rows, rows[0]!))).toBe(2);
  });
  it("does not count permission-only or entirely unbound evidence", () => {
    expect(countCopilotEditOriginsForTarget(captured().filter(n => n.stage !== "tool"), deniedTarget)).toBe(0);
    expect(countCopilotEditOriginsForTarget(captured().filter(n => n.stage === "tool"), deniedTarget)).toBe(0);
  });
  it.each([
    { target: "other.txt" }, { operation: "execute" as const },
  ])("rejects conflicting tool evidence %j", conflict => {
    const rows = captured(); rows[3] = { ...rows[3]!, ...conflict };
    expect(() => countCopilotEditOriginsForTarget(rows, deniedTarget)).toThrow(/Conflicting/);
  });
  it("rejects another permission request on the same tool origin", () => {
    const rows = captured(); rows[2] = { ...rows[2]!, requestId: "other" };
    expect(() => countCopilotEditOriginsForTarget(rows, deniedTarget)).toThrow(/permission/);
    expect(() => countCopilotEditOriginsForTarget([...captured(), { ...captured()[1]!, seq: 46 }], deniedTarget)).toThrow(/permission/);
  });
  it("rejects a restarted or repeated native lifecycle under a reused origin", () => {
    for (const status of ["pending", "in_progress", "completed", "failed"] as const) {
      expect(() => countCopilotEditOriginsForTarget([...captured(), { ...notice, status, seq: 46 }], deniedTarget)).toThrow(/lifecycle/);
    }
  });
});
function receipt(): CopilotRemoteSnapshot {
  const root = { pid: 50, ppid: 1, startTicks: "200", bootId: "12345678-1234-1234-1234-123456789abc" };
  return { binding: { companyId: "company", environmentId: "env", runId: "run", leaseId: "lease", sandboxId: "sandbox", image: `image@sha256:${"a".repeat(64)}`, remoteCwd: "/home/daytona/workspace" },
    observedAtMs: 60, receivedAtMs: 61, observedMonotonicNs: "600", complete: true, workspace: {},
    targets: { [target]: { absent: true, sha256: null, complete: true, mutationCount: 0, parent: { dev: "1", ino: "2" } } },
    watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 }, processes: { captured: true, root, journal: [root], live: [] },
    setup: { path: ".action.txt", sha256: `sha256:${"b".repeat(64)}`, published: true },
    attached: { connections: 1, failure: null, commandExit: { code: 0, observedAtMs: 20, observedMonotonicNs: "200" }, markerWrittenAtMs: 25, markerWrittenMonotonicNs: "250", clientExitedAtMs: 30, clientExitedMonotonicNs: "300" } };
}
function baseline() { const s = receipt(); s.observedAtMs = 1; s.observedMonotonicNs = "1"; s.processes.live = [50]; s.setup = { ...s.setup, published: false, sha256: null }; return s; }
describe("Copilot sealed remote proof", () => {
  it("requires exact lease and original process identity in the retained final receipt", () => {
    expect(() => assertCopilotRemoteRetirement(receipt(), baseline())).not.toThrow();
    for (const mutate of [
      (s: CopilotRemoteSnapshot) => { s.binding.leaseId = "foreign"; },
      (s: CopilotRemoteSnapshot) => { s.processes.live = [50]; },
      (s: CopilotRemoteSnapshot) => { s.processes.root!.startTicks = "999"; },
      (s: CopilotRemoteSnapshot) => { s.processes.captured = false; },
      (s: CopilotRemoteSnapshot) => { s.processes.journal = []; },
      (s: CopilotRemoteSnapshot) => { s.setup.published = false; },
      (s: CopilotRemoteSnapshot) => { s.watcher.complete = false; },
    ]) { const s = receipt(); mutate(s); expect(() => assertCopilotRemoteRetirement(s, baseline())).toThrow(); }
  });
  it("rejects transient remote writes, parent replacement and unrelated workspace changes", () => {
    expect(copilotRemoteDeniedSample(receipt(), baseline(), target, "after-cleanup").exists).toBe(false);
    for (const mutate of [
      (s: CopilotRemoteSnapshot) => { s.targets[target]!.mutationCount = 2; },
      (s: CopilotRemoteSnapshot) => { s.targets[target]!.parent.ino = "new"; },
      (s: CopilotRemoteSnapshot) => { s.targets[target]!.complete = false; },
      (s: CopilotRemoteSnapshot) => { s.watcher.workspaceMutationCount = 1; },
      (s: CopilotRemoteSnapshot) => { s.workspace.other = `sha256:${"a".repeat(64)}`; },
    ]) { const s = receipt(); mutate(s); expect(() => copilotRemoteDeniedSample(s, baseline(), target, "after-cleanup")).toThrow(); }
  });
  it("requires independent attached child/client ordering and rejects early terminal", () => {
    expect(assertCopilotRemoteAttached(receipt(), baseline(), 50).connections).toBe(1);
    for (const mutate of [
      (s: CopilotRemoteSnapshot) => { s.attached!.connections = 2; },
      (s: CopilotRemoteSnapshot) => { s.attached!.commandExit!.code = 1; },
      (s: CopilotRemoteSnapshot) => { s.attached!.clientExitedMonotonicNs = "240"; },
      (s: CopilotRemoteSnapshot) => { s.attached!.markerWrittenMonotonicNs = null; },
      (s: CopilotRemoteSnapshot) => { s.attached!.clientExitedAtMs = 51; },
    ]) { const s = receipt(); mutate(s); expect(() => assertCopilotRemoteAttached(s, baseline(), 50)).toThrow(); }
    expect(() => assertCopilotRemoteAttached(receipt(), baseline(), 20)).toThrow();
  });
  it("exempts only exact completed action-file reads before the tested operation", () => {
    const call = { ...notice, seq: 10, status: "in_progress" as const };
    const read = { ...notice, toolCallId: "bootstrap", operation: "read", status: "completed", seq: 1 } as CopilotToolNotice;
    const actionFile = `.paperclip-eval-action-${"a".repeat(36)}.txt`;
    const event = { runId: "run", seq: 2, protocolSchemaVersion: 1, eventType: "tool.execution.completed", payload: { prpEvent: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: "run", turnId: "turn", eventType: "tool.execution.completed", emittedAt: new Date(2).toISOString(),
      payload: { schema: "paperclip.tool.execution.v1", executionId: "bootstrap", transport: "builtin", operation: "read", target: actionFile, status: "completed" },
    } } };
    read.readTargetSha256 = `sha256:${createHash("sha256").update(actionFile).digest("hex")}`;
    const proof = { actionFile, events: [event] };
    expect(countCopilotToolOrigins(copilotActionNotices([read, call], call, proof))).toBe(1);
    const wrong = structuredClone(event); wrong.payload.prpEvent.payload.target = "unrelated.txt";
    expect(() => copilotActionNotices([read, call], call, { actionFile, events: [wrong] })).toThrow();
    expect(() => copilotActionNotices([read, { ...read, toolCallId: "unrelated", seq: 3 }, call], call, proof)).toThrow();
    expect(() => copilotActionNotices([{ ...read, turnId: "other" }, call], call, proof)).toThrow();
    for (const bad of [{ ...read, seq: 11 }, { ...read, operation: undefined }, { ...read, operation: "edit" as const }]) {
      expect(countCopilotToolOrigins(copilotActionNotices([bad, call], call, { actionFile, events: [] }))).toBe(2);
    }
    expect(countCopilotToolOrigins(copilotActionNotices([read, call], call))).toBe(2);
  });
  it("awaits the remote fixture and baseline before disclosing the actual command", async () => {
    const s = baseline(), order: string[] = [];
    const fixture: CopilotRemoteFixture = { binding: s.binding, remoteCwd: s.binding.remoteCwd, actionFile: s.setup.path,
      snapshot: async () => { await Promise.resolve(); order.push("baseline"); return s; },
      setupAttachedCommand: async input => { expect(input.markerText).toBe("private-marker"); order.push("setup"); return { command: "exact-remote-command", commandSha256: `sha256:${"c".repeat(64)}` }; },
      finish: async () => { throw new Error("must not finish during setup"); }, readFile: async () => { throw new Error("must not read host file"); }, close: async () => {} };
    const prepared = await prepareCopilotRemoteAction({ fixture, companyId: "company", environmentId: "env", runId: "run", target, prompt: "test", markerText: "private-marker" });
    order.push("publish"); expect(order).toEqual(["setup", "baseline", "publish"]);
    expect(prepared.prompt).toContain("exact-remote-command"); expect(prepared.prompt).not.toContain("private-marker");
    await expect(prepareCopilotRemoteAction({ fixture, companyId: "company", environmentId: "env", runId: "other", target, prompt: "test" })).rejects.toThrow(/Foreign/);
    s.targets[target]!.absent = false;
    await expect(prepareCopilotRemoteAction({ fixture, companyId: "company", environmentId: "env", runId: "run", target, prompt: "test" })).rejects.toThrow(/present/);
  });
});

it("uses sealed retained bytes after lease deletion, rejects changed/deleted markers, and never snapshots again", async () => {
  const { readCopilotRemoteMarkerAfterRetirement } = await import("./copilot-protection-evidence.js");
  const { createHash } = await import("node:crypto");
  const end = receipt(); end.targets[target] = { ...end.targets[target]!, absent: false, sha256: `sha256:${createHash("sha256").update("marker").digest("hex")}` };
  let finished = false, bytes: Buffer | undefined = Buffer.from("marker");
  const fixture = {
    finish: async () => { finished = true; return end; },
    snapshot: async () => { throw new Error("lease destroyed: RPC forbidden"); },
    readFile: async () => { if (!finished) throw new Error("not retained yet"); if (!bytes) throw new Error("terminal_file_missing"); return Buffer.from(bytes); },
  } as unknown as CopilotRemoteFixture;
  expect(await readCopilotRemoteMarkerAfterRetirement(fixture, baseline(), target, "marker")).toBe(true);
  bytes = Buffer.from("changed"); expect(await readCopilotRemoteMarkerAfterRetirement(fixture, baseline(), target, "marker")).toBe(false);
  bytes = undefined; await expect(readCopilotRemoteMarkerAfterRetirement(fixture, baseline(), target, "marker")).rejects.toThrow(/missing/);
});


describe("Copilot fixture command equivalence", () => {
  const command = "'/pinned/node' '/fixture/client.cjs' '/fixture/private/socket' 'nonce'";
  const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const captured = (prefix = " "): CopilotToolNotice[] => [
    { ...notice, operation: "execute", mode: "async", detach: false, commandSha256: digest(prefix + command), status: "pending", seq: 38 },
    { ...notice, operation: "execute", mode: "async", detach: false, commandSha256: digest(prefix + command), status: "completed", shellId: "0", shellState: "started", commandToolCallId: notice.toolCallId, seq: 54 },
    { ...notice, operation: "read", toolCallId: "shell-read", status: "completed", shellId: "0", shellState: "completed", commandToolCallId: notice.toolCallId, exitCode: 0, seq: 105 },
  ];
  it.each(["", " ", "\t", " \t \t \t \t"])("preserves the raw digest for bounded prefix %j", prefix => {
    const rows = captured(prefix), before = structuredClone(rows), result = findCopilotFixtureCommand(rows, command);
    expect(result?.match).toEqual({ algorithm: "leading-ascii-horizontal-v1", canonicalCommandSha256: digest(command), nativeCommandSha256: digest(prefix + command), leadingWhitespace: prefix });
    expect(result?.call).toBe(rows[0]); expect(rows).toEqual(before);
  });
  it.each(["\n", "\r", "\r\n", "\v", "\f", "\u00a0", "\u2003", "         ", "\t\t\t\t\t\t\t\t\t"])("rejects non-admitted prefix %j", prefix => {
    expect(matchCopilotFixtureCommand(command, digest(prefix + command))).toBeNull();
  });
  it.each([
    command + " ", command + "\t", command.replace("node' '", "node'  '"), command.replaceAll("'", '"'),
    command.replace("client.cjs", "other.cjs"), command.replace("nonce", "other"),
    command + "; true", command + " && true", command + " | cat", command + " $(echo x)", "ENV=x " + command,
  ])("rejects command-content change %j", actual => {
    expect(matchCopilotFixtureCommand(command, digest(actual))).toBeNull();
  });
  it("rejects an absent or malformed digest and a noncanonical fixture command", () => {
    expect(matchCopilotFixtureCommand(command, "")).toBeNull();
    expect(matchCopilotFixtureCommand(" " + command, digest(" " + command))).toBeNull();
    expect(findCopilotFixtureCommand([], command)).toBeNull();
    expect(findCopilotFixtureCommand(captured().map(n => ({ ...n, commandSha256: undefined })), command)).toBeNull();
  });
  it.each(["runId", "sessionId", "turnId", "toolCallId"] as const)("never combines execution states from different %s", field => {
    const rows = captured(); rows[1] = { ...rows[1]!, [field]: "foreign" };
    expect(findCopilotFixtureCommand(rows, command)).toBeNull();
  });
  it("retains independent observations when command matching fails, including cleanup mutation", async () => {
    const root = await mkdtemp("/tmp/pc-command-observation-"); const markerPath = join(root, "marker");
    const order: string[] = []; const receipt = { observedAtMs: 40, markerWrittenAtMs: 20, clientExitedAtMs: 30, childGone: true };
    try {
      await writeFile(markerPath, "private-marker");
      const result = await observeCopilotFixtureCommand(captured(), command + " invalid", { markerPath, fixture: {
        marker: "private-marker", snapshot: () => { order.push("snapshot"); return receipt; },
        close: async () => { order.push("close"); await writeFile(markerPath, "changed-during-cleanup"); },
      } });
      expect(result).toEqual({ external: receipt, markerMatches: true, afterCleanupMarkerMatches: false, matched: null });
      expect(order).toEqual(["snapshot", "close"]);
      expect(result.external?.observedAtMs).toBe(40); // Original observation time, never cleanup time.
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects retries, another command, conflicting input and reused lifecycle", () => {
    for (const extra of [
      { ...captured()[0]!, toolCallId: "retry" },
      { ...captured()[1]!, toolCallId: "retry" },
      { ...captured()[0]!, toolCallId: "other", commandSha256: digest(command + " other") },
      { ...captured()[0]!, seq: 39 }, { ...captured()[1]!, seq: 55 },
      { ...captured()[0]!, status: "in_progress" as const, seq: 55 },
    ]) expect(findCopilotFixtureCommand([...captured(), extra], command)).toBeNull();
    for (const conflict of [{ commandSha256: digest(command) }, { mode: "sync" as const }, { detach: true }, { operation: "edit" as const }, { status: "failed" as const }]) {
      const rows = captured(); rows[1] = { ...rows[1]!, ...conflict };
      expect(findCopilotFixtureCommand(rows, command)).toBeNull();
    }
  });
});

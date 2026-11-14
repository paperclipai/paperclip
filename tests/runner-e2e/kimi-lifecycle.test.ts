import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { statSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSameKimiPending, observeKimiLifecyclePending, readKimiLifecycleSettlement } from "./kimi-lifecycle-evidence.js";
import { dispatchKimiLifecycleAction } from "./kimi-lifecycle.js";
import { KIMI_MAC_PROCESS_OBSERVER, readKimiLocalProcesses, selectKimiLocalTarget, type KimiLocalProcess } from "./kimi-local-provider-fault.js";

type Row = Record<string, any>;
const caller = { type: "board", userId: "local-board", source: "local_implicit" } as const;
const cancellationRequestId = "11111111-2222-4333-8444-555555555555";
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture(remote = false) {
  const scope = { companyId: "company", issueId: "issue", runId: "run", target: "denied/target.txt", ...(remote ? { actionFile: `.paperclip-eval-action-${"a".repeat(36)}.txt` } : {}) };
  const run: Row = { id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "running", nativeSessionId: "session", runnerInstanceId: "runner", resultJson: {} };
  const issue: Row = { id: "issue", companyId: "company", status: "in_progress" };
  const row = (eventType: string, sourceSeq: number, payload: Row): Row => ({ companyId: "company", runId: "run", seq: sourceSeq, eventType, protocolSchemaVersion: 1,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn", normalizedSessionId: "session",
      sourceInstanceId: "runner", sourceSeq, sourceEventId: `runner:run:${sourceSeq}`, emittedAt: "2026-10-28T00:00:00Z", payload } } });
  const tool = (executionId: string, name: string, operation: string, target: string | null, status = "running") => ({ schema: "paperclip.tool.execution.v1", executionId, transport: "builtin", name, operation, target, status });
  const request: Row = { schema: "paperclip.runtime_request.v2", type: "permission", requestKind: "permission_approval", status: "pending", requestId: "request", turnId: "turn", itemId: "permission-item",
    prompt: `Change file: ${scope.target}`, choices: [{ key: "accept", label: "Allow once" }, { key: "decline", label: "Deny" }, { key: "cancel", label: "Cancel" }],
    details: { toolCallId: "0:native-write" }, origin: { adapter: "acpx-runtime-sidecar", provider: "kimi", method: "session/request_permission" } };
  const events: Row[] = remote ? [row("tool.execution.started", 1, tool("0:read", "Read", "read", scope.actionFile!)), row("tool.execution.completed", 2, tool("0:read", "Read", "read", scope.actionFile!, "completed"))] : [];
  events.push(row("tool.execution.started", events.length + 1, tool("0:native-write", "Write", "edit", null)),
    row("tool.execution.progressed", events.length + 2, tool("0:native-write", "Write", "edit", null)),
    row("runtime_request.created", events.length + 3, { request }));
  const state = () => ({ run, issue, events });
  const observe = () => observeKimiLifecyclePending({ ...state(), scope });
  const settle = (branch: "stop" | "loss", cancelId = cancellationRequestId) => {
    const pending = observe();
    if (branch === "stop") {
      run.status = "cancelled";
      run.resultJson = { startupCancellation: { cancellationRequestId: cancelId, requestedBy: { type: "board", userId: "local-board" } }, nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${cancelId}`, companyId: "company", runId: "run", issueId: "issue", scope: "run",
        dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit",
      } };
      events.push(row("runtime_request.cancelled", events.length + 1, { requestId: "request", requestKind: "permission_approval", turnId: "turn", itemId: "permission-item", reason: "turn_terminal" }));
      events.push(row("turn.cancelled", events.length + 1, { status: "cancelled", error: null }));
    } else {
      run.status = "failed"; issue.status = "blocked";
      events.push(row("runtime_request.expired", events.length + 1, { requestId: "request", requestKind: "permission_approval", requestType: "permission", turnId: "turn", itemId: "permission-item", reason: "provider_process_lost", replayAllowed: false }));
      events.push(row("turn.failed", events.length + 1, { error: { code: "provider_transport_lost" } }));
    }
    const dispatchMonotonicNs = process.hrtime.bigint().toString();
    return { pending, dispatchMonotonicNs, caller, cancellationRequestId: cancelId, branch };
  };
  return { scope, run, issue, events, request, row, tool, state, observe, settle };
}
const payload = (row: Row) => row.payload.prpEvent.payload;

function retainedLocalStopRows() {
  const scope = { companyId: "26725944-fac6-4382-883c-a57d5448a3ba", issueId: "9334a1c6-3f67-4536-8570-e81db0b70498",
    runId: "209bc4ba-4f54-4ff8-98b2-49879cfb52f8", target: "pc-denied-6WPcjH/kimi-stop-c5be66dab0a0-1.txt" };
  const session = "18298d7f-4d8f-4185-8ae7-660daa69ead7", source = "38cdabd8-af4c-4c76-9f20-9931e36475df",
    turn = "turn_lab_8e3a1a4a520442ad80c36025a1353ba6", item = `item-${scope.runId}`, toolCallId = "0:tool_uKx4azxIHxpU6e5TZ2xLHbVj";
  const origin = { method: "session/request_permission", adapter: "acpx-runtime-sidecar", provider: "kimi" };
  const choices = [{ key: "accept", label: "Allow once" }, { key: "decline", label: "Deny" }, { key: "cancel", label: "Cancel" }];
  const request = { type: "permission", itemId: item, method: "session/request_permission", origin,
    prompt: `Change file: ${scope.target}`, schema: "paperclip.runtime_request.v2", status: "pending", turnId: turn, choices,
    details: { itemId: item, origin, reason: `Change file: ${scope.target}`, turnId: turn, choices,
      threadId: "paperclip-9558eb1e0ea79ed9b728d62643b53ab02477d5a4711ef634d8cf0c5b5d8d0af9", toolCallId },
    requestId: "acpx-input-25f63168069f72f421df7bd9", requestKind: "permission_approval" };
  const row = (eventType: string, seq: number, sourceSeq: number, emittedAt: string, value: Row): Row => ({
    companyId: scope.companyId, runId: scope.runId, seq, eventType, protocolSchemaVersion: 1,
    payload: { prpEvent: { runId: scope.runId, itemId: item, schema: "paperclip.prp.event.v1", turnId: turn, payload: value,
      priority: 1, emittedAt, eventType, sourceSeq, sourceKind: "runner", schemaVersion: 1,
      sourceEventId: `${source}:${scope.runId}:${sourceSeq}`, sourceInstanceId: source, normalizedSessionId: session } },
  });
  const events = [row("tool.execution.started", 59, 30, "2026-10-28T14:48:05.538Z", {
    name: "Write", output: "null", schema: "paperclip.tool.execution.v1", status: "running", target: null, exitCode: null,
    progress: "Write (pending)", readOnly: false, namespace: null, operation: "edit", transport: "builtin", durationMs: null,
    executionId: toolCallId, outputBytes: 4, inputUpdated: false,
    outputDigest: "sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b", outputTruncated: false,
  }), row("runtime_request.created", 141, 112, "2026-10-28T14:48:06.604Z", { request })];
  return { scope, events,
    run: { id: scope.runId, companyId: scope.companyId, nativeIssueId: scope.issueId, status: "running", runtimeMode: "native",
      nativeSessionId: session, runnerInstanceId: source, resultJson: null },
    issue: { id: scope.issueId, companyId: scope.companyId, status: "in_progress" } };
}

describe("Kimi native Write lifecycle evidence", () => {
  it("accepts retained local Stop rows with a null execution target and no permission kind", () => {
    const actual = retainedLocalStopRows();
    expect(payload(actual.events[0]!).target).toBeNull();
    expect(payload(actual.events[1]!).request.details).not.toHaveProperty("kind");
    expect(observeKimiLifecyclePending(actual)).toMatchObject({
      requestId: "acpx-input-25f63168069f72f421df7bd9", toolCallId: "0:tool_uKx4azxIHxpU6e5TZ2xLHbVj",
      executionId: "0:tool_uKx4azxIHxpU6e5TZ2xLHbVj", startedSourceSeq: 30, requestSourceSeq: 112,
    });
  });
  it.each(["target", "kind", "callback", "edit-operation", "tool-name", "prompt"])("rejects conflicting retained local Stop %s", conflict => {
    const actual = retainedLocalStopRows(), tool = payload(actual.events[0]!), request = payload(actual.events[1]!).request;
    if (conflict === "target") tool.target = "another.txt";
    if (conflict === "kind") request.details.kind = "execute";
    if (conflict === "callback") request.details.toolCallId = "0:other";
    if (conflict === "edit-operation") tool.operation = "execute";
    if (conflict === "tool-name") tool.name = "Edit";
    if (conflict === "prompt") request.prompt = "Change file: another.txt";
    expect(() => observeKimiLifecyclePending(actual)).toThrow();
  });
  it("accepts explicit matching edit metadata without requiring it on the native permission", () => {
    const f = fixture();
    f.request.details.kind = "edit"; payload(f.events[1]!).target = f.scope.target;
    expect(f.observe().executionId).toBe("0:native-write");
  });
  it.each([false, true])("binds actual Write approval to its native edit execution (remote=%s)", remote => {
    const f = fixture(remote), before = f.observe(), later = f.observe();
    expect(before).toMatchObject({ toolCallId: "0:native-write", executionId: "0:native-write", normalizedSessionId: "session", sourceInstanceId: "runner" });
    expect(() => assertSameKimiPending(before, later)).not.toThrow();
  });
  it.each([
    ["another provider", (f: ReturnType<typeof fixture>) => { f.request.origin.provider = "copilot"; }],
    ["semantic permission", f => { f.request.origin.method = "semantic/tool"; }],
    ["missing safe card path", f => { f.request.prompt = "Write"; }],
    ["conflicting permission kind", f => { f.request.details.kind = "other"; }],
    ["session-wide authority", f => { f.request.choices.push({ key: "accept_for_session" }); }],
    ["missing decline", f => { f.request.choices = f.request.choices.filter((x: Row) => x.key !== "decline"); }],
    ["wrong native call", f => { f.request.details.toolCallId = "foreign"; }],
    ["different file", f => { payload(f.events[1]!).target = "elsewhere.txt"; }],
    ["native Edit substituted for Write", f => { payload(f.events[1]!).name = "Edit"; }],
    ["completed file effect", f => { f.events.push(f.row("tool.execution.completed", 4, f.tool("0:native-write", "Write", "edit", f.scope.target, "completed"))); }],
    ["extra shell", f => { f.events.unshift(f.row("tool.execution.started", 0, f.tool("shell", "Bash", "execute", null))); }],
    ["replayed start", f => { f.events.push(f.row("tool.execution.started", 4, f.tool("0:native-write", "Write", "edit", f.scope.target))); }],
    ["foreign company", f => { f.events[0]!.companyId = "foreign"; }],
    ["foreign source", f => { f.events[0]!.payload.prpEvent.sourceInstanceId = "other"; }],
    ["restored session", f => { f.run.nativeSessionId = "replacement"; }],
    ["another provider generation", f => { f.run.runnerInstanceId = "replacement"; }],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => void]>)("rejects %s", (_name, mutate) => {
    const f = fixture(); mutate(f); expect(f.observe).toThrow();
  });
  it.each(["wrong-path", "unclosed", "extra-write", "post-write-read"])("rejects ambiguous bootstrap %s", kind => {
    const f = fixture(true);
    if (kind === "wrong-path") payload(f.events[0]!).target = "another.txt";
    if (kind === "unclosed") f.events.splice(1, 1);
    if (kind === "extra-write") payload(f.events[0]!).operation = "edit";
    if (kind === "post-write-read") { f.events[0]!.seq = 99; }
    expect(f.observe).toThrow();
  });
  it.each(["stop", "loss"] as const)("accepts the original %s callback closure", branch => {
    const f = fixture(), binding = f.settle(branch);
    expect(readKimiLifecycleSettlement({ ...f.state(), ...binding })).toMatchObject({ branch, replayAllowed: false, completedMutation: false });
    payload(f.events.at(-2)!).requestId = "other";
    expect(() => readKimiLifecycleSettlement({ ...f.state(), ...binding })).toThrow();
  });
  it("keeps the observed permission row bound when native expiry omits its full request", () => {
    const f = fixture(), binding = f.settle("loss");
    expect(payload(f.events.at(-2)!)).not.toHaveProperty("request");
    expect(readKimiLifecycleSettlement({ ...f.state(), ...binding })).toMatchObject({ branch: "loss", replayAllowed: false });
    f.request.choices[0].label = "Changed after pending observation";
    expect(() => readKimiLifecycleSettlement({ ...f.state(), ...binding })).toThrow("original pre-action pending receipt changed or missing");
  });
  it.each(["replay", "cancelled", "wrong-reason", "changed-request", "injected-original-request", "new-turn", "new-operation", "success", "Stop"])("rejects false native loss %s", kind => {
    const f = fixture(), binding = f.settle("loss"), expiry = f.events.at(-2)!;
    if (kind === "replay") payload(expiry).replayAllowed = true;
    if (kind === "cancelled") expiry.eventType = expiry.payload.prpEvent.eventType = "runtime_request.cancelled";
    if (kind === "wrong-reason") payload(expiry).reason = "durable_handoff";
    if (kind === "changed-request") payload(expiry).request = { ...f.request, prompt: "replacement" };
    if (kind === "injected-original-request") payload(expiry).request = f.request;
    if (kind === "new-turn") { f.events.at(-1)!.payload.prpEvent.turnId = "replacement"; }
    if (kind === "new-operation") f.events.push(f.row("tool.execution.started", 6, f.tool("late", "Write", "edit", f.scope.target)));
    if (kind === "success") f.run.status = "succeeded";
    if (kind === "Stop") f.run.resultJson.nativeCancellation = {};
    expect(() => readKimiLifecycleSettlement({ ...f.state(), ...binding })).toThrow();
  });
  it("refuses a changed pending callback before dispatching a Stop or fault", async () => {
    const f = fixture(); let reads = 0, actions = 0;
    await expect(dispatchKimiLifecycleAction({ scope: f.scope, caller, branch: "stop", deadlineAt: Date.now() + 1000,
      load: async () => { if (++reads === 2) f.request.requestId = "replacement"; return f.state(); }, retain: async () => {},
      act: async () => { actions++; } })).rejects.toThrow("pending callback changed");
    expect(actions).toBe(0);
  });
  it("retains and refreshes the pending observation before its only mutating action", async () => {
    const f = fixture(), order: string[] = [];
    const result = await dispatchKimiLifecycleAction({ scope: f.scope, caller, branch: "stop", deadlineAt: Date.now() + 1000,
      load: async () => { order.push("load"); return f.state(); }, retain: async () => { order.push("retain"); },
      act: async (_pending, requestId) => { order.push("action"); f.settle("stop", requestId); return { source: "public-Stop-test-double" }; } });
    expect(order.slice(0, 4)).toEqual(["load", "retain", "load", "action"]);
    expect(order.filter(x => x === "action")).toHaveLength(1);
    expect(result.settlement.branch).toBe("stop");
  });
});

function localFixture() {
  const timestamp = Date.parse("2026-10-28T00:00:00Z"), distribution = "/private/tmp/paperclip-acpx-native-fixture/distribution";
  const bootId = "12345678-1234-1234-1234-123456789abc", loader = "exact compiled guarded loader";
  const proc = (pid: number, ppid: number, executable: string, command: string): KimiLocalProcess => ({ pid, ppid, pgid: pid === 21 ? 21 : 22,
    startUs: String(timestamp * 1000 + pid), executable, executableDev: "1", executableIno: String(pid), command, argv: [executable], cwd: "/workspace", bootId });
  const processes = [proc(21, 1, "/runner", "/runner --run-id run --lifecycle-mode per_turn"),
    proc(22, 21, "/host-node", `/host-node --eval ${loader} ${distribution} .paperclip-native-entry.cjs 0 0 commonjs [] 0`),
    proc(23, 22, `${distribution}/node/bin/node`, "kimi-code")];
  processes[1]!.argv = ["/host-node", "--eval", loader, distribution, ".paperclip-native-entry.cjs", "0", "0", "commonjs", "[]", "0"];
  const input = { authority: { pid: 21, groupId: 21, startedAt: new Date(timestamp).toISOString(), runId: "run" },
    journal: processes.map(row => ({ pid: row.pid, parent: row.ppid, start: new Date(timestamp).toISOString() })), processes, workspacePath: "/workspace", guardLoaderSha256: sha(loader) };
  return { input, select: () => selectKimiLocalTarget(input) };
}
describe("Kimi local native child selector", () => {
  it("selects the exact pinned-path native descendant independently of its title", () => {
    const f = localFixture(); expect(f.select().target.pid).toBe(23);
    f.input.processes[2]!.command = "anything"; expect(f.select().target.pid).toBe(23);
  });
  it("uses byte-exact loader argv even when ps renders a different command", () => {
    const f = localFixture(); f.input.processes[1]!.command = "a rendered command that cannot preserve loader bytes";
    expect(f.select().target.pid).toBe(23);
  });
  it("decodes exactly argc arguments and excludes the trailing environment", () => {
    const source = KIMI_MAC_PROCESS_OBSERVER.slice(KIMI_MAC_PROCESS_OBSERVER.indexOf("def decode_arguments(data):"), KIMI_MAC_PROCESS_OBSERVER.indexOf("def arguments(pid):"));
    const run = (bytes: Buffer) => execFileSync("/usr/bin/python3", ["-I", "-B", "-c", `import base64,json,struct,sys\n${source}\nprint(json.dumps(decode_arguments(base64.b64decode(sys.argv[1]))))`, bytes.toString("base64")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const args = ["/node", "--eval", "line-one\nline-two", ""];
    const header = Buffer.alloc(4); header.writeInt32LE(args.length);
    const body = Buffer.from(`/node\0\0${args.join("\0")}\0CANARY=must-never-be-returned\0`);
    const decoded = run(Buffer.concat([header, body])); expect(JSON.parse(decoded)).toEqual(args); expect(decoded).not.toContain("CANARY");
    for (const count of [0, 129]) { const wrong = Buffer.from(header); wrong.writeInt32LE(count); expect(() => run(Buffer.concat([wrong, body]))).toThrow(); }
    const changed = Buffer.from(header); changed.writeInt32LE(5);
    expect(() => run(Buffer.concat([changed, Buffer.from(`/node\0\0${args.join("\0")}\0`) ]))).toThrow();
    expect(() => run(Buffer.concat([header, Buffer.from("/node\0\0/node\0--eval\0truncated")]))).toThrow();
    expect(() => run(Buffer.alloc(2))).toThrow();
  });
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("reads literal multiline argv without retaining a real child's environment", async () => {
    const program = 'process.stdout.write("ready");setInterval(()=>{},1000)';
    const literal = "line-one\nline-two";
    const child = spawn(process.execPath, ["--eval", program, literal], { env: { PATH: "/usr/bin:/bin", CANARY: "must-never-be-returned" }, stdio: ["ignore", "pipe", "ignore"] });
    const closed = new Promise(resolve => child.once("close", resolve));
    try {
      await new Promise(resolve => child.stdout!.once("data", resolve));
      const rows = readKimiLocalProcesses([child.pid!]);
      expect(rows[0]!.argv).toEqual([process.execPath, "--eval", program, literal]);
      expect(JSON.stringify(rows)).not.toContain("must-never-be-returned");
    } finally { child.kill("SIGTERM"); await closed; }
  });
  it.each(["root", "foreign-loader", "wrong-entry", "unowned", "wrong-cwd", "boot", "cycle", "ambiguous"])("fails closed for %s", kind => {
    const f = localFixture();
    if (kind === "root") f.input.authority.runId = "other";
    if (kind === "foreign-loader") f.input.processes[1]!.argv[2] = "wrong loader";
    if (kind === "wrong-entry") f.input.processes[1]!.argv[4] = "foreign.cjs";
    if (kind === "unowned") f.input.journal.pop();
    if (kind === "wrong-cwd") f.input.processes[2]!.cwd = "/elsewhere";
    if (kind === "boot") f.input.processes[2]!.bootId = "foreign";
    if (kind === "cycle") f.input.processes[1]!.ppid = 23;
    if (kind === "ambiguous") { f.input.processes.push({ ...f.input.processes[2]!, pid: 24 }); f.input.journal.push({ ...f.input.journal[2]!, pid: 24 }); }
    expect(f.select).toThrow();
  });
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("reads real macOS kernel process birth and executable inode without environment inspection", () => {
    const rows = readKimiLocalProcesses([process.pid]), current = rows.find(row => row.pid === process.pid);
    expect(current?.executable).toBe(realpathSync(process.execPath));
    const stat = statSync(current!.executable);
    expect(current?.executableDev).toBe(String(stat.dev)); expect(current?.executableIno).toBe(String(stat.ino));
    expect(Math.abs(Date.now() - Number(current!.startUs) / 1000 - process.uptime() * 1000)).toBeLessThan(5000);
  });
});

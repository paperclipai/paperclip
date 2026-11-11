import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CursorCloudClient, type CursorCloudSseEvent } from "../../packages/paperclip-runner/src/drivers/cursor-cloud/cloud-client.js";
import { cursorCloudStopTask } from "./cursor-cloud-cases.js";
import { CursorCloudStopCommandObserver, CursorCloudStopCommandTracker, readPendingCursorCloudStopExecution } from "./cursor-cloud-stop-observation.js";

const localRunId = "local-run", agentId = "bc-11111111-1111-4111-8111-111111111111", nativeRunId = "run-22222222-2222-4222-8222-222222222222";
const filename = "cursor-cloud-after-stop-nonce.txt";
const command = "sleep 180 && printf 'MUST_NOT_APPEAR\\n' > '/artifacts/" + filename + "'";
const digest = createHash("sha256").update(command).digest("hex");
const pending = { callId: "delayed-command", toolName: "run_terminal_cmd", commandSha256: digest };
const event = (type: string, executionId: string, seq: number) => ({ runId: localRunId, seq, protocolSchemaVersion: 1, payload: { prpEvent: {
  schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: localRunId, eventType: `tool.execution.${type}`,
  payload: { schema: "paperclip.tool.execution.v1", executionId, transport: "builtin", name: "run_terminal_cmd", status: type === "completed" ? "succeeded" : "running" },
} } });
const native = (status: string, callId = pending.callId, requestedCommand = command): CursorCloudSseEvent => ({ event: "tool_call", data: { callId, name: pending.toolName, status, args: { command: requestedCommand } } });
const observers: CursorCloudStopCommandObserver[] = [];
afterEach(async () => { await Promise.all(observers.splice(0).map(observer => observer.close())); vi.restoreAllMocks(); });

async function wireObserver(deadlineAt = Date.now() + 60_000) {
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined, signal: AbortSignal | undefined, sequence = 0;
  const cancelled = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async (resource, init) => {
    expect(String(resource)).toBe(`https://api.cursor.com/v1/agents/${agentId}/runs/${nativeRunId}/stream`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
    signal = init?.signal ?? undefined;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      writer = controller;
      signal?.addEventListener("abort", () => { try { controller.error(new Error("owned observation aborted")); } catch {} }, { once: true });
    }, cancel: cancelled }), { headers: { "content-type": "text/event-stream" } });
  });
  const observer = new CursorCloudStopCommandObserver({ client: new CursorCloudClient({ apiKey: "fixture-key", fetch: fetcher }), agentId, runId: nativeRunId, artifactName: filename, deadlineAt });
  observers.push(observer);
  await vi.waitFor(() => expect(writer).toBeDefined());
  return { observer, fetcher, cancelled, signal: () => signal, send(value: CursorCloudSseEvent) {
    writer!.enqueue(new TextEncoder().encode(`id: ${++sequence}\nevent: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`));
  }, lose() { writer!.error(new Error("native stream disconnected")); } };
}

it("rejects a completed setup tool while the Cloud run remains active", () => {
  expect(readPendingCursorCloudStopExecution([event("started", "setup", 1), event("completed", "setup", 2)], localRunId)).toBeUndefined();
});
it("requires native evidence of the exact delayed command", () => {
  expect(readPendingCursorCloudStopExecution([event("started", "setup", 1)], localRunId, pending)).toBeUndefined();
});
it("matches exact native SSE command identity to persisted facade events after completed setup", async () => {
  const f = await wireObserver();
  f.send(native("running", "setup", "pwd")); f.send(native("completed", "setup", "pwd")); f.send(native("running"));
  await vi.waitFor(() => expect(f.observer.pending()).toEqual(pending));
  const rows = [event("started", "setup", 1), event("completed", "setup", 2), event("started", pending.callId, 3)];
  expect(readPendingCursorCloudStopExecution(rows, localRunId, f.observer.pending())).toBe(pending.callId);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.observer.pending())).not.toContain(command);
});
it("rejects a native completion racing the final Stop recheck before its persisted completion arrives", async () => {
  const f = await wireObserver(), rows = [event("started", pending.callId, 1)];
  f.send(native("running")); await vi.waitFor(() => expect(f.observer.pending()).toEqual(pending));
  expect(readPendingCursorCloudStopExecution(rows, localRunId, f.observer.pending())).toBe(pending.callId);
  f.send(native("completed")); await vi.waitFor(() => expect(f.observer.pending()).toBeUndefined());
  expect(readPendingCursorCloudStopExecution(rows, localRunId, f.observer.pending())).toBeUndefined();
  f.send(native("running"));
  await new Promise(resolve => setImmediate(resolve));
  expect(f.observer.pending()).toBeUndefined();
});
it("rejects a persisted completion even when the native observer has not received it yet", () => {
  expect(readPendingCursorCloudStopExecution([event("started", pending.callId, 1), event("completed", pending.callId, 2)], localRunId, pending)).toBeUndefined();
});
it.each(["owner", "schema", "source", "tool", "changed-repeat", "terminal"])("rejects mismatched or settled %s execution evidence", reason => {
  const row = event("started", pending.callId, 1), rows = [row];
  if (reason === "owner") row.runId = "foreign";
  if (reason === "schema") row.protocolSchemaVersion = 2;
  if (reason === "source") row.payload.prpEvent.sourceKind = "provider";
  if (reason === "tool") row.payload.prpEvent.payload.name = "different-tool";
  if (reason === "changed-repeat") { const changed = event("started", pending.callId, 2); changed.payload.prpEvent.payload.name = "different-tool"; rows.push(changed); }
  if (reason === "terminal") row.payload.prpEvent.eventType = "turn.completed";
  expect(readPendingCursorCloudStopExecution(rows, localRunId, pending)).toBeUndefined();
});
it.each([command + " &", command.replace("180", "1"), command.replace(filename, "unrelated.txt"), "echo " + command,
  command.replace("/artifacts/", "../"), command.replace("/artifacts/", "/artifacts/../"), command + "; true"])("rejects commands outside the exact foreground fixture: %s", value => {
  const tracker = new CursorCloudStopCommandTracker(filename, nativeRunId); tracker.consume(native("running", pending.callId, value));
  expect(tracker.pending()).toBeUndefined();
});
it("fails closed when the native observation stream is lost after command admission", async () => {
  const f = await wireObserver(); f.send(native("running")); await vi.waitFor(() => expect(f.observer.pending()).toEqual(pending));
  f.lose(); await vi.waitFor(() => expect(() => f.observer.pending()).toThrow("stream was lost"));
});
it("clears pending commands on the exact native terminal result", async () => {
  const f = await wireObserver(); f.send(native("running")); await vi.waitFor(() => expect(f.observer.pending()).toEqual(pending));
  f.send({ event: "result", data: { runId: nativeRunId, status: "FINISHED" } });
  await vi.waitFor(() => expect(f.observer.pending()).toBeUndefined());
});
it("fails closed on a foreign run frame and closes its owned stream", async () => {
  const f = await wireObserver(); f.send({ event: "status", data: { runId: "run-33333333-3333-4333-8333-333333333333", status: "RUNNING" } });
  await vi.waitFor(() => expect(() => f.observer.pending()).toThrow("stream was lost"));
  await f.observer.close(); expect(f.cancelled).toHaveBeenCalledTimes(1);
});
it("aborts its attempt-owned observer at the existing fixture deadline", async () => {
  const f = await wireObserver(Date.now() + 100);
  await vi.waitFor(() => expect(() => f.observer.pending()).toThrow("deadline expired"));
  expect(f.signal()?.aborted).toBe(true);
});
it("rejects expired observation before opening a native stream", () => {
  const streamRun = vi.fn();
  expect(() => new CursorCloudStopCommandObserver({ client: { streamRun }, agentId, runId: nativeRunId, artifactName: filename, deadlineAt: Date.now() - 1 })).toThrow("deadline expired");
  expect(streamRun).not.toHaveBeenCalled();
});

it("admits the actual Stop prompt command after substituting only its documented output directory", () => {
  const prompt = cursorCloudStopTask.buildPrompt("nonce");
  const requested = prompt.split("with that directory: ")[1]!.split(". Do not add a wrapper")[0]!.replace("/ABSOLUTE_OUTPUT_DIRECTORY", "/artifacts");
  expect(requested).toBe(command);
  const tracker = new CursorCloudStopCommandTracker(filename, nativeRunId);
  tracker.consume(native("running", pending.callId, requested));
  expect(tracker.pending()).toEqual(pending);
});

it("matches the observed argument-free running frame followed by the same command's argument update", async () => {
  const f = await wireObserver();
  f.send({ event: "tool_call", data: { callId: pending.callId, name: pending.toolName, status: "running" } });
  f.send(native("running"));
  await vi.waitFor(() => expect(f.observer.pending()).toEqual(pending));
  const rows = [event("started", pending.callId, 1), event("started", pending.callId, 2)];
  expect(readPendingCursorCloudStopExecution(rows, localRunId, f.observer.pending())).toBe(pending.callId);
});
it("accepts a route-owned status frame without a repeated native run ID", () => {
  const tracker = new CursorCloudStopCommandTracker(filename, nativeRunId);
  tracker.consume({ event: "status", data: { status: "RUNNING" } });
  tracker.consume(native("running"));
  expect(tracker.pending()).toEqual(pending);
});
it("settles a route-owned result without a repeated native run ID", () => {
  const tracker = new CursorCloudStopCommandTracker(filename, nativeRunId);
  tracker.consume(native("running"));
  tracker.consume({ event: "result", data: { status: "FINISHED" } });
  expect(tracker.pending()).toBeUndefined();
});

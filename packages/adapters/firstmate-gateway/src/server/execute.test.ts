import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { execute } from "./execute.js";

test("dispatches a Paperclip run and completes only on its matching terminal event", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    socket.send(JSON.stringify({ type: "hello", role: "events" }));
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== "paperclip.dispatch") return;
      socket.send(JSON.stringify({ type: "paperclip.dispatch_ack", runId: frame.runId, accepted: true }));
      socket.send(JSON.stringify({ type: "paperclip.run_event", runId: "other", agentId: frame.agentId, kind: "completed" }));
      socket.send(JSON.stringify({ type: "paperclip.run_event", runId: frame.runId, agentId: frame.agentId, kind: "completed", message: "done" }));
    });
  });
  const result = await execute({
    runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "FirstMate", adapterType: "firstmate_gateway", adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { url: `ws://127.0.0.1:${port}/events`, authToken: "test-token", timeoutSec: 3 }, context: { task: { id: "task-1", title: "Test" } }, onLog: async () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, "done");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("uses a stable synthetic task ID for a taskless heartbeat", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  let dispatchedTaskId: unknown;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", role: "events" }));
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== "paperclip.dispatch") return;
      dispatchedTaskId = frame.taskId;
      socket.send(JSON.stringify({ type: "paperclip.dispatch_ack", runId: frame.runId, accepted: true }));
      socket.send(JSON.stringify({ type: "paperclip.run_event", runId: frame.runId, agentId: frame.agentId, kind: "completed", message: "done" }));
    });
  });

  const result = await execute({
    runId: "run-taskless",
    agent: { id: "agent-1", companyId: "company-1", name: "FirstMate", adapterType: "firstmate_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { url: `ws://127.0.0.1:${port}/events`, authToken: "test-token", timeoutSec: 3 },
    context: {},
    onLog: async () => {},
  });

  assert.equal(dispatchedTaskId, "heartbeat:run-taskless");
  assert.equal(result.exitCode, 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("fails immediately when the relay rejects dispatch", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", role: "events" }));
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== "paperclip.dispatch") return;
      socket.send(JSON.stringify({ type: "paperclip.dispatch_ack", runId: frame.runId, accepted: false, error: "invalid_dispatch" }));
    });
  });

  const startedAt = Date.now();
  const result = await execute({
    runId: "run-rejected",
    agent: { id: "agent-1", companyId: "company-1", name: "FirstMate", adapterType: "firstmate_gateway", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { url: `ws://127.0.0.1:${port}/events`, authToken: "test-token", timeoutSec: 2 },
    context: { task: { id: "task-1", title: "Test" } },
    onLog: async () => {},
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.errorCode, "FIRSTMATE_REJECTED");
  assert.match(result.errorMessage ?? "", /invalid_dispatch/);
  assert.ok(Date.now() - startedAt < 1_000, "relay rejection should not wait for the adapter timeout");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

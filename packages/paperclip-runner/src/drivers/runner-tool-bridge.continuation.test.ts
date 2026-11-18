import { afterEach, expect, it, vi } from "vitest";
import { startRunnerToolBridge, type RunnerToolBridge } from "./runner-tool-bridge.js";

const bridges: RunnerToolBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });

it("advertises readable continuation fields and rejects malformed waits before dispatch", async () => {
  const handler = vi.fn(async () => ({ accepted: true }));
  const bridge = await startRunnerToolBridge({ tools: [], handler });
  bridges.push(bridge);
  const rpc = async (body: Record<string, unknown>, secret = bridge.secret) => fetch(bridge.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  const listed = await (await rpc({ id: "list", method: "tools/list" })).json() as {
    result: { tools: Array<{ name: string; inputSchema: { properties: { continuation: Record<string, unknown> } } }> };
  };
  const continuation = listed.result.tools.find(tool => tool.name === "paperclip_finish")!.inputSchema.properties.continuation;
  expect(continuation).not.toHaveProperty("allOf");
  expect(continuation.required).toEqual(["kind", "summary", "idempotencyKey"]);

  const report = {
    reportedWorkDisposition: "yielded",
    summary: "The requested result is ready.",
    completionClaim: { contractRevision: "1", objectiveSatisfied: false, criteria: [], remainingWork: [] },
    evidence: [], verification: [],
    continuation: { kind: "monitor", summary: "Check the saved monitor.", idempotencyKey: "stable-wait" },
  };
  const call = async (id: string, value: unknown) => (await (await rpc({
    id, method: "tools/call", params: { name: "paperclip_finish", arguments: value },
  })).json() as { result: { isError?: boolean; content?: unknown } }).result;

  const { idempotencyKey: _key, ...missingKey } = report.continuation;
  for (const [index, invalid] of [
    missingKey,
    { ...report.continuation, idempotencyKey: "" },
    { ...report.continuation, idempotencyKey: 42 },
    { ...report.continuation, kind: "case_handoff" },
  ].entries()) {
    expect((await call(`invalid-${index}`, { ...report, continuation: invalid })).isError).toBe(true);
  }
  expect((await call("wrong-disposition", { ...report, reportedWorkDisposition: "done" })).isError).toBe(true);
  expect((await rpc({ id: "unauthorized", method: "tools/call", params: { name: "paperclip_finish", arguments: report } }, "wrong-secret")).status).toBe(401);
  expect(handler).not.toHaveBeenCalled();

  const accepted = await call("monitor", report);
  expect(accepted.isError).not.toBe(true);
  expect(await call("monitor", report)).toEqual(accepted);
  expect(handler).toHaveBeenCalledOnce();
  expect((await call("monitor", { ...report, continuation: { ...report.continuation, idempotencyKey: "different" } })).isError).toBe(true);
  expect(handler).toHaveBeenCalledOnce();
  for (const [index, valid] of [
    { ...report.continuation, kind: "response_wake" },
    { ...report.continuation, kind: "case_handoff", handoffId: "server-issued-handoff" },
    null,
  ].entries()) {
    expect((await call(`valid-${index}`, { ...report, continuation: valid })).isError).not.toBe(true);
  }
  const { continuation: _continuation, ...omitted } = report;
  expect((await call("omitted", omitted)).isError).not.toBe(true);
  expect(handler).toHaveBeenCalledTimes(5);
});

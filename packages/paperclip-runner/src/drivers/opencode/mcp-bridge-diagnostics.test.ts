import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { startOpenCodeMcpBridge, type OpenCodeMcpBridge } from "./mcp-bridge.js";

const bridges: OpenCodeMcpBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });

const report = {
  reportedWorkDisposition: "done", summary: "Completed the synthetic request.",
  completionClaim: { contractRevision: "1", objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
  evidence: [], verification: [],
};

async function rpc(bridge: OpenCodeMcpBridge, id: number, method: string, params?: unknown) {
  return (await fetch(bridge.url, { method: "POST", headers: {
    Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json();
}

it("binds closed rejection shapes to the actual offered finish schema without recording values", async () => {
  const messages: string[] = [], handler = vi.fn(async () => ({ accepted: true }));
  const bridge = await startOpenCodeMcpBridge({ handler, onDiagnostic: message => messages.push(message) });
  bridges.push(bridge);
  const listed = await rpc(bridge, 1, "tools/list");
  const schema = listed.result.tools.find((tool: { name: string }) => tool.name === "paperclip_finish").inputSchema;
  const digest = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  for (const [index, input] of [report, { ...report, continuation: null }].entries()) {
    const result = await rpc(bridge, index + 2, "tools/call", { name: "paperclip_finish", arguments: input });
    expect(result.result.isError).not.toBe(true);
  }
  for (const [index, continuation] of ["PRIVATE_INPUT_VALUE", [], 42, false].entries()) {
    const rejected = await rpc(bridge, index + 4, "tools/call", {
      name: "paperclip_finish", arguments: { ...report, continuation },
    });
    expect(rejected.result.isError).toBe(true);
  }
  const unrelated = await rpc(bridge, 8, "tools/call", {
    name: "paperclip_finish", arguments: { ...report, summary: 42, continuation: null, PRIVATE_FIELD: "PRIVATE_INPUT_VALUE" },
  });
  expect(unrelated.result.isError).toBe(true);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(messages.map(message => JSON.parse(message))).toEqual([
    { schema: "paperclip.opencode.finish-input-diagnostic/v1", stage: "offered", schemaSha256: digest },
    ...["string", "array", "number", "boolean"].map((continuationShape, index) => ({
      schema: "paperclip.opencode.finish-input-diagnostic/v1", stage: "input_rejected",
      schemaSha256: digest, callIdSha256: createHash("sha256").update(String(index + 4)).digest("hex"),
      validationCategory: "continuation", rootShape: "object", continuationShape,
    })),
    { schema: "paperclip.opencode.finish-input-diagnostic/v1", stage: "input_rejected",
      schemaSha256: digest, callIdSha256: createHash("sha256").update("8").digest("hex"),
      validationCategory: "other", rootShape: "object", continuationShape: "null" },
  ]);
  expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_INPUT_VALUE|PRIVATE_FIELD|Completed|criteria|continuation.*must|instancePath/);
});

it("reports the effective supplied schema and bounds diagnostics without admitting rejected inputs", async () => {
  const messages: string[] = [], handler = vi.fn();
  const inputSchema = { type: "object", required: ["continuation"], properties: { continuation: { type: "object" } } };
  const bridge = await startOpenCodeMcpBridge({
    tools: [{ name: "paperclip_finish", inputSchema }], handler,
    onDiagnostic: message => messages.push(message),
  });
  bridges.push(bridge);
  for (let index = 0; index < 12; index++) {
    const rejected = await rpc(bridge, index, "tools/call", {
      name: "paperclip_finish", arguments: index === 0 ? [] : { continuation: null },
    });
    expect(rejected.result.isError).toBe(true);
  }
  expect(handler).not.toHaveBeenCalled();
  expect(messages).toHaveLength(9);
  expect(JSON.parse(messages[0]!)).toMatchObject({ schemaSha256: createHash("sha256").update(JSON.stringify(inputSchema)).digest("hex") });
  expect(JSON.parse(messages[1]!)).toMatchObject({ rootShape: "array", continuationShape: "omitted", validationCategory: "root" });
  expect(JSON.parse(messages[2]!)).toMatchObject({ rootShape: "object", continuationShape: "null", validationCategory: "continuation" });
  expect(messages.every(message => Buffer.byteLength(message) < 448)).toBe(true);
});

it("keeps diagnostics optional and nonfatal while preserving cancellation", async () => {
  const aborted = vi.fn();
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const bridge = await startOpenCodeMcpBridge({ timeoutMs: null,
    onDiagnostic: () => { throw new Error("unavailable diagnostic sink"); },
    handler: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(new Error("cancelled")); });
      started();
    }),
  });
  bridges.push(bridge);
  const pending = rpc(bridge, 1, "tools/call", { name: "paperclip_finish", arguments: report });
  await begun;
  await fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) });
  expect((await pending).result.isError).toBe(true);
  expect(aborted).toHaveBeenCalledOnce();
});

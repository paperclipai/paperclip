import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { startRunnerToolBridge, type RunnerToolBridge } from "./runner-tool-bridge.js";

type FixtureCase = { name: string; accepted: boolean; schema: Record<string, unknown>; valid?: unknown[]; invalid?: unknown[] };
const fixtures = JSON.parse(readFileSync(new URL("../../test/fixtures/tool-input-schema-fixtures.json", import.meta.url), "utf8")) as { cases: FixtureCase[] };
const bridges: RunnerToolBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });

async function rpc(bridge: RunnerToolBridge, body: Record<string, unknown>) {
  const response = await fetch(bridge.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  return await response.json() as { result: { tools?: Array<{ name: string }>; isError?: boolean } };
}

it("starts with every app schema dialect, reused $id values and an uncompilable schema, validating each tool on its own", async () => {
  const calls: string[] = [];
  const bridge = await startRunnerToolBridge({
    preserveToolNames: true,
    tools: [
      { name: "get_task_context", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      ...fixtures.cases.map(fixture => ({ name: `app_${fixture.name}`, description: fixture.name, inputSchema: fixture.schema })),
    ],
    handler: async call => { calls.push(call.tool); return { ok: true }; },
  });
  bridges.push(bridge);
  const listed = (await rpc(bridge, { id: 1, method: "tools/list" })).result.tools!.map(tool => tool.name);
  expect(listed).toEqual([
    "get_task_context",
    ...fixtures.cases.filter(fixture => fixture.accepted).map(fixture => `app_${fixture.name}`),
    "paperclip_finish",
    "paperclip_block",
  ]);
  let id = 2;
  for (const fixture of fixtures.cases) {
    const name = `app_${fixture.name}`;
    if (!fixture.accepted) {
      expect((await rpc(bridge, { id: id++, method: "tools/call", params: { name, arguments: {} } })).result.isError).toBe(true);
      continue;
    }
    for (const input of fixture.valid ?? []) {
      expect((await rpc(bridge, { id: id++, method: "tools/call", params: { name, arguments: input } })).result.isError).not.toBe(true);
    }
    for (const input of fixture.invalid ?? []) {
      expect((await rpc(bridge, { id: id++, method: "tools/call", params: { name, arguments: input } })).result.isError).toBe(true);
    }
  }
  expect(calls.filter(name => !fixtures.cases.some(fixture => fixture.accepted && `app_${fixture.name}` === name))).toEqual([]);
  expect((await rpc(bridge, { id: id++, method: "tools/call", params: { name: "get_task_context", arguments: { unexpected: true } } })).result.isError).toBe(true);
  expect((await rpc(bridge, { id: id++, method: "tools/call", params: { name: "paperclip_finish", arguments: { summary: 1 } } })).result.isError).toBe(true);
  expect(calls).not.toContain("get_task_context");
  expect(calls).not.toContain("paperclip_finish");
});

it("refuses a Paperclip-owned private tool whose schema cannot compile", async () => {
  await expect(startRunnerToolBridge({
    tools: [],
    privateTools: [{ name: "__paperclip_permission", inputSchema: { type: "object", properties: { a: { type: "text" } } } }],
    handler: async () => ({ ok: true }),
  })).rejects.toThrow("has an invalid input schema");
});

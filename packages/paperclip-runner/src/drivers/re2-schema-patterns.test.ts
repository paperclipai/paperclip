import { afterEach, expect, it } from "vitest";
import { taskDocumentKeySchema } from "../protocol-actions/task-document-key-schema.js";
import { re2PortableSchema } from "./re2-schema-patterns.js";
import { startRunnerToolBridge, type RunnerToolBridge } from "./runner-tool-bridge.js";

const bridges: RunnerToolBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(bridge => bridge.close())); });

async function rpc(bridge: RunnerToolBridge, body: Record<string, unknown>) {
  const response = await fetch(bridge.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  return await response.json() as { result: { tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>; isError?: boolean } };
}

it("rewrites ECMAScript \\u escapes in patterns to the RE2 form the Antigravity CLI's validator compiles", () => {
  const schema = { type: "object", properties: {
    key: taskDocumentKeySchema,
    escaped: { type: "string", pattern: "^a\\\\u0041$" },
    emoji: { type: "string", pattern: "^\\ud83d\\ude00$" },
    lone: { type: "string", pattern: "^\\ud83d$" },
    braced: { type: "string", pattern: "^\\u{1F600}$" },
  }, patternProperties: { ["^x\\u0041$"]: { type: "string" } } };
  const portable = re2PortableSchema(schema) as { properties: Record<string, { pattern?: string }>; patternProperties: Record<string, unknown> };
  // The live failure: the CLI refused the whole toolbox for this one pattern.
  expect(portable.properties.key.pattern).not.toMatch(/(^|[^\\])(\\\\)*\\u/);
  expect(portable.properties.key.pattern).toContain(String.raw`\x{212a}`);
  expect(portable.properties.key.pattern).toContain(String.raw`[\x{0009}-\x{000d}`);
  // An escaped backslash followed by "u" is literal text, not an escape.
  expect(portable.properties.escaped.pattern).toBe(String.raw`^a\\u0041$`);
  expect(portable.properties.emoji.pattern).toBe(String.raw`^\x{1f600}$`);
  expect(portable.properties.braced.pattern).toBe(String.raw`^\x{1f600}$`);
  // A lone surrogate has no RE2 form: the pattern is left out (the bridge still validates it).
  expect(portable.properties.lone).toEqual({ type: "string" });
  expect(Object.keys(portable.patternProperties)).toEqual([String.raw`^x\x{0041}$`]);
  // The source schema is unchanged.
  expect(schema.properties.key.pattern).toBe(taskDocumentKeySchema.pattern);
});

it("serves RE2 patterns to the CLI while validating calls with the original schema", async () => {
  const calls: unknown[] = [];
  const bridge = await startRunnerToolBridge({
    preserveToolNames: true, schemaPatternDialect: "re2",
    tools: [{ name: "read_document", inputSchema: { type: "object", properties: { key: taskDocumentKeySchema }, required: ["key"], additionalProperties: false } }],
    handler: async call => { calls.push(call.arguments); return { ok: true }; },
  });
  bridges.push(bridge);
  const listed = (await rpc(bridge, { id: 1, method: "tools/list" })).result.tools!;
  const served = (listed.find(tool => tool.name === "read_document")!.inputSchema.properties as Record<string, { pattern: string }>).key.pattern;
  expect(served).toContain(String.raw`\x{212a}`);
  expect(JSON.stringify(listed)).not.toMatch(/\\\\u[0-9a-fA-F]{4}/);
  expect((await rpc(bridge, { id: 2, method: "tools/call", params: { name: "read_document", arguments: { key: "plan" } } })).result.isError).not.toBe(true);
  expect((await rpc(bridge, { id: 3, method: "tools/call", params: { name: "read_document", arguments: { key: "x{212a}" } } })).result.isError).toBe(true);
  expect(calls).toEqual([{ key: "plan" }]);
});

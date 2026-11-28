import { afterEach, expect, it } from "vitest";
import { taskDocumentKeySchema } from "../protocol-actions/task-document-key-schema.js";
import { re2Incompatibility, re2PortableSchema } from "./re2-schema-patterns.js";
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
    lookahead: { type: "string", pattern: "^(?!\\.)[a-z]+$" },
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
  expect(portable.properties.lookahead).toEqual({ type: "string" });
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

function servedPatterns(value: unknown, path: string, out: Array<{ path: string; pattern: string }>): void {
  if (Array.isArray(value)) { value.forEach((item, index) => servedPatterns(item, `${path}[${index}]`, out)); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "pattern" && typeof child === "string") out.push({ path, pattern: child });
    if (key === "patternProperties" && child && typeof child === "object") {
      for (const pattern of Object.keys(child)) out.push({ path: `${path}.patternProperties`, pattern });
    }
    servedPatterns(child, `${path}.${key}`, out);
  }
}

it("serves only RE2-compatible patterns for every Paperclip tool on the swarm route", async () => {
  const { PAPERCLIP_PROTOCOL_ACTIONS } = await import("../protocol-actions/index.js");
  const tools: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
  const collect = (value: unknown, name: string): void => {
    if (Array.isArray(value)) { value.forEach(item => collect(item, name)); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "inputSchema" && child && typeof child === "object") tools.push({ name: `${name}_${tools.length}`, inputSchema: child as Record<string, unknown> });
      else collect(child, name);
    }
  };
  for (const action of PAPERCLIP_PROTOCOL_ACTIONS) collect(action, String((action as { name?: unknown }).name ?? "action"));
  expect(tools.length).toBeGreaterThan(40);
  const bridge = await startRunnerToolBridge({ preserveToolNames: true, schemaPatternDialect: "re2", tools, handler: async () => ({ ok: true }) });
  bridges.push(bridge);
  const listed = (await rpc(bridge, { id: 1, method: "tools/list" })).result.tools!;
  const patterns: Array<{ path: string; pattern: string }> = [];
  for (const tool of listed) servedPatterns(tool.inputSchema, tool.name, patterns);
  // The live failure came from one such pattern, so the guard must see some.
  expect(patterns.some(entry => entry.pattern.includes(String.raw`\x{212a}`))).toBe(true);
  expect(patterns.flatMap(entry => {
    const problem = re2Incompatibility(entry.pattern);
    return problem ? [`${entry.path}: ${problem}: ${entry.pattern}`] : [];
  })).toEqual([]);
});

it("tells the model in plain words which rule a value broke when the CLI never saw the pattern", async () => {
  const bridge = await startRunnerToolBridge({
    preserveToolNames: true, schemaPatternDialect: "re2",
    tools: [{ name: "read_document", inputSchema: { type: "object", properties: { key: taskDocumentKeySchema }, required: ["key"], additionalProperties: false } }],
    handler: async () => ({ ok: true }),
  });
  bridges.push(bridge);
  const response = await fetch(bridge.url, {
    method: "POST", headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_document", arguments: { key: "notes.md" } } }),
  });
  const result = (await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  expect(result.isError).toBe(true);
  const text = result.content[0]!.text;
  expect(text).toMatch(/^Invalid tool input: \/key /);
  // The rule the served schema no longer carried, as the schema's own words.
  expect(text).toContain("key: Stable document identifier, not a filename or path");
});

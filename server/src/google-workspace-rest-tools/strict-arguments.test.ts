import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeGoogle, json } from "./fixtures/fake-google.js";
import { GMAIL_TOOLS } from "./gmail/index.js";
import { CALENDAR_TOOLS } from "./calendar/index.js";
import { DOCS_TOOLS } from "./docs/index.js";
import { DRIVE_TOOLS } from "./drive/index.js";
import { SHEETS_TOOLS } from "./sheets/index.js";
import { SLIDES_TOOLS } from "./slides/index.js";
import { defineTool, unmodeledSchemaParts } from "./tool.js";
import { callGoogleWorkspaceRestTool, GOOGLE_WORKSPACE_REST_SERVICES, listGoogleWorkspaceRestTools } from "./tools.js";

type Schema = Record<string, unknown>;
const isRecord = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

function objectNodes(schema: unknown, path = ""): Array<{ path: string; node: Schema }> {
  if (!isRecord(schema)) return [];
  const own = schema.type === "object" || isRecord(schema.properties) ? [{ path, node: schema }] : [];
  const children = isRecord(schema.properties)
    ? Object.entries(schema.properties).flatMap(([name, item]) => objectNodes(item, path ? `${path}.${name}` : name))
    : [];
  return [...own, ...children, ...objectNodes(schema.items, `${path}[]`)];
}

const ALL_TOOLS = GOOGLE_WORKSPACE_REST_SERVICES.flatMap((service) => listGoogleWorkspaceRestTools(service).map((tool) => ({ service, tool })));
const REST_TOOLS = [...GMAIL_TOOLS, ...CALENDAR_TOOLS, ...DRIVE_TOOLS, ...DOCS_TOOLS, ...SLIDES_TOOLS, ...SHEETS_TOOLS];
const PASS_THROUGH = ["docs update_doc requests[]", "slides update_presentation requests[]", "sheets update_spreadsheet requests[]"];

describe("unknown arguments", () => {
  it("covers all 36 tools", () => {
    expect(ALL_TOOLS).toHaveLength(36);
    expect(REST_TOOLS).toHaveLength(36);
  });

  it("advertises additionalProperties: false on every input object, except Google's pass-through request objects", () => {
    const open: string[] = [];
    for (const { service, tool } of ALL_TOOLS) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      for (const { path, node } of objectNodes(tool.inputSchema)) {
        if (isRecord(node.properties)) expect(node.additionalProperties, `${tool.name} ${path}`).toBe(false);
        else open.push(`${service} ${tool.name} ${path}`);
      }
    }
    expect(open.sort()).toEqual([...PASS_THROUGH].sort());
  });

  it("validates exactly the arguments each tool advertises, with the same object structure", () => {
    for (const tool of REST_TOOLS) {
      const parsed = z.toJSONSchema(tool.args, { io: "input", unrepresentable: "any" });
      const keys = (schema: unknown) => Object.fromEntries(objectNodes(schema)
        .filter(({ node }) => isRecord(node.properties))
        .map(({ path, node }) => [path || "(top level)", Object.keys(node.properties as Schema).sort()]));
      expect(keys(parsed), tool.definition.name).toEqual(keys(tool.definition.inputSchema));
    }
  });

  it("advertises the same types, enums and required fields that each tool validates", () => {
    const contract = (schema: unknown) => Object.fromEntries(objectNodes(schema)
      .filter(({ node }) => isRecord(node.properties))
      .flatMap(({ path, node }) => Object.entries(node.properties as Record<string, Schema>)
        .map(([name, item]) => [path ? `${path}.${name}` : name, { type: item.type ?? null, enum: Array.isArray(item.enum) ? [...item.enum].sort() : null }])));
    const required = (schema: unknown) => objectNodes(schema).filter(({ node }) => isRecord(node.properties))
      .flatMap(({ path, node }) => ((node.required as string[] | undefined) ?? []).map((name) => (path ? `${path}.${name}` : name)));
    const requiredOnlyInAdvertisedSchema: string[] = [];
    for (const tool of REST_TOOLS) {
      const parsed = z.toJSONSchema(tool.args, { io: "input", unrepresentable: "any" });
      expect(contract(tool.definition.inputSchema), tool.definition.name).toEqual(contract(parsed));
      const advertised = required(tool.definition.inputSchema);
      expect(advertised, tool.definition.name).toEqual(expect.arrayContaining(required(parsed)));
      requiredOnlyInAdvertisedSchema.push(...advertised.filter((name) => !required(parsed).includes(name)).map((name) => `${tool.definition.name} ${name}`));
    }
    expect(requiredOnlyInAdvertisedSchema.sort()).toEqual([
      "update_doc writeControl", "update_doc writeControl.requiredRevisionId",
      "update_presentation writeControl", "update_presentation writeControl.requiredRevisionId",
    ]);
  });

  it.each([
    ["docs", "update_doc", { documentId: "doc1", requests: [{ insertText: { text: "Hi", location: { index: 1 } } }] }],
    ["slides", "update_presentation", { presentationId: "deck1", requests: [{ createSlide: {} }] }],
  ] as const)("%s %s refuses a call without writeControl.requiredRevisionId before sending", async (service, name, args) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    for (const call of [args, { ...args, writeControl: {} }]) {
      const result = await callGoogleWorkspaceRestTool({ service, name, arguments: call, accessToken: "t", fetch });
      expect(result.isError, JSON.stringify(call)).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/requiredRevisionId/);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses at definition time a schema whose parts the check cannot follow", () => {
    const base = { name: "probe", annotations: { readOnlyHint: false } };
    const run = async () => ({ content: [] });
    expect(() => defineTool({ definition: { ...base, inputSchema: { type: "object", properties: { a: { anyOf: [{ type: "object", properties: { b: { type: "string" } } }] } } } }, args: z.object({}), run }))
      .toThrow("probe: the unknown-argument check cannot follow inputSchema.properties.a.anyOf");
    expect(() => defineTool({ definition: { ...base, inputSchema: { type: "object", properties: { a: { type: "array", items: [{ type: "object" }] } } } }, args: z.object({}), run }))
      .toThrow("inputSchema.properties.a.items (tuple)");
    expect(() => defineTool({ definition: { ...base, inputSchema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "string" } } }, args: z.object({}), run }))
      .toThrow("inputSchema.additionalProperties (open beside properties)");
    expect(() => defineTool({ definition: { ...base, inputSchema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: true } }, args: z.object({}), run }))
      .toThrow("inputSchema.additionalProperties (open beside properties)");
    for (const { tool } of ALL_TOOLS) expect(unmodeledSchemaParts(tool.inputSchema, tool.name)).toEqual([]);
  });

  it.each(ALL_TOOLS.map(({ service, tool }) => [`${service}__${tool.name}`, service, tool] as const))(
    "%s refuses an unknown argument by name, lists the accepted ones, and sends nothing to Google",
    async (_label, service, tool) => {
      const { fetch, calls } = fakeGoogle(() => json({}));
      const result = await callGoogleWorkspaceRestTool({ service, name: tool.name, arguments: { unexpectedArgument: "x" }, accessToken: "t", fetch });
      const accepted = Object.keys(tool.inputSchema.properties ?? {}).join(", ");
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: `Invalid arguments for ${tool.name}: unknown argument "unexpectedArgument". Accepted arguments: ${accepted}. Nothing was sent to Google.` }],
      });
      expect(calls).toHaveLength(0);
    },
  );

  it("names every unknown argument in one error", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await callGoogleWorkspaceRestTool({ service: "gmail", name: "search_messages", arguments: { q: "x", filter: "y", pageSize: 5 }, accessToken: "t", fetch });
    expect(result.content).toEqual([{ type: "text", text: "Invalid arguments for search_messages: unknown arguments \"q\", \"filter\". Accepted arguments: pageSize, pageToken, query, includeTrash, messageFormat. Nothing was sent to Google." }]);
    expect(calls).toHaveLength(0);
  });

  it("refuses unknown fields inside structured inputs, with their path", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const event = await callGoogleWorkspaceRestTool({
      service: "calendar", name: "create_event", accessToken: "t", fetch,
      arguments: { summary: "Plan", startTime: "2026-11-24T10:00:00Z", endTime: "2026-11-24T10:30:00Z", attendees: [{ email: "sam@example.test", role: "owner" }] },
    });
    expect(event.isError).toBe(true);
    expect((event.content as Array<{ text: string }>)[0]!.text).toMatch(/^Invalid arguments for create_event: unknown argument "role" in attendees\[0\]\. Accepted in attendees\[0\]: id, email, .+\. Nothing was sent to Google\.$/);
    const doc = await callGoogleWorkspaceRestTool({
      service: "docs", name: "update_doc", accessToken: "t", fetch,
      arguments: { documentId: "doc1", requests: [{ insertText: { text: "Hi", location: { index: 1 } } }], writeControl: { requiredRevisionId: "rev-1", force: true } },
    });
    expect((doc.content as Array<{ text: string }>)[0]!.text).toMatch(/unknown argument "force" in writeControl\. Accepted in writeControl: requiredRevisionId/);
    expect(calls).toHaveLength(0);
  });

  it("passes Google's request objects through unchanged", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ documentId: "doc1", replies: [{}], writeControl: { requiredRevisionId: "rev-2" } }));
    const request = { insertText: { text: "Hi", location: { index: 1, tabId: "t.0" } } };
    const result = await callGoogleWorkspaceRestTool({
      service: "docs", name: "update_doc", accessToken: "t", fetch,
      arguments: { documentId: "doc1", requests: [request], writeControl: { requiredRevisionId: "rev-1" } },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { requests: unknown[] }).requests).toEqual([request]);
  });
});

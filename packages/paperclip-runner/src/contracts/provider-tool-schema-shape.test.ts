import { expect, test } from "vitest";
import { PAPERCLIP_SEMANTIC_ACTION_CATALOG } from "../catalog/semantic-action-catalog.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-driver-values.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../semantic-tools/catalog.js";
import {
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_RESULT_BRIDGE_INPUT_SCHEMA,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_TOOL_NAME,
} from "./completion-result.js";
import { providerToolSchemaShapeIssues } from "./provider-tool-schema-shape.js";

function offenders(tools: Iterable<{ name: string; schema: unknown }>) {
  return [...tools].flatMap(({ name, schema }) => {
    const issues = providerToolSchemaShapeIssues(schema);
    return issues.length ? [`${name}: ${issues.join(", ")}`] : [];
  });
}

test("every agent-facing runner tool advertises a plain object root with named properties", () => {
  const tools = [
    ...CAPABILITY_SEMANTIC_TOOL_CATALOG.map(tool => ({ name: tool.operationId, schema: tool.inputSchema })),
    ...PAPERCLIP_SEMANTIC_ACTION_CATALOG.map(tool => ({ name: `catalog:${tool.operationId}`, schema: tool.inputSchema })),
    ...codexSemanticToolSpecs().map(tool => ({ name: `codex:${String(tool.name)}`, schema: tool.inputSchema })),
    { name: PRP_COMPLETION_TOOL_NAME, schema: PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA },
    { name: `${PRP_COMPLETION_TOOL_NAME}:bridge`, schema: PRP_COMPLETION_RESULT_BRIDGE_INPUT_SCHEMA },
    { name: PRP_BLOCK_TOOL_NAME, schema: PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA },
  ];
  expect(tools.length).toBeGreaterThan(50);
  expect(offenders(tools)).toEqual([]);
});

test("the shape check names each root defect", () => {
  expect(providerToolSchemaShapeIssues({ type: "object", oneOf: [{}, {}] })).toEqual(["root has no properties object", "root uses oneOf"]);
  expect(providerToolSchemaShapeIssues({ type: "object", properties: {}, if: {}, then: {} })).toEqual(["root uses if", "root uses then"]);
  expect(providerToolSchemaShapeIssues({ type: "object", properties: { a: { oneOf: [{}, {}] } } })).toEqual([]);
});

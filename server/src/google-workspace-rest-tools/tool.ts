import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { GoogleToolError } from "./errors.js";
import type { GoogleHttp } from "./google-http.js";

export const FALLBACK_MAX_RESULT_BYTES = 250_000;

export interface ToolLimits {
  maxResultBytes: number;
}

export const FALLBACK_TOOL_LIMITS: ToolLimits = { maxResultBytes: FALLBACK_MAX_RESULT_BYTES };

export interface RestToolSpec<Args> {
  definition: Tool;
  args: z.ZodType<Args>;
  whenTooLarge?: string | ((args: Args) => string);
  run(args: Args, http: GoogleHttp, limits: ToolLimits): Promise<CallToolResult>;
}

export interface RestTool {
  definition: Tool;
  args: z.ZodType;
  call(rawArgs: unknown, http: GoogleHttp, limits?: ToolLimits): Promise<CallToolResult>;
}

export function defineTool<Args>(spec: RestToolSpec<Args>): RestTool {
  const readOnly = spec.definition.annotations?.readOnlyHint === true;
  if (readOnly !== (spec.whenTooLarge !== undefined)) {
    throw new Error(`${spec.definition.name}: a read tool must say how to ask for less, and a write tool must not`);
  }
  const unmodeled = unmodeledSchemaParts(spec.definition.inputSchema, "inputSchema");
  if (unmodeled.length > 0) {
    throw new Error(`${spec.definition.name}: the unknown-argument check cannot follow ${unmodeled.join(", ")}`);
  }
  const definition: Tool = { ...spec.definition, inputSchema: closedObjectSchema(spec.definition.inputSchema) as Tool["inputSchema"] };
  return {
    definition,
    args: spec.args,
    async call(rawArgs, http, limits = FALLBACK_TOOL_LIMITS) {
      const unknown = unknownArgumentProblems(rawArgs ?? {}, definition.inputSchema, "");
      if (unknown.length > 0) {
        return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${spec.definition.name}: ${unknown.join(" ")} Nothing was sent to Google.` }] };
      }
      const parsed = spec.args.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ");
        return { isError: true, content: [{ type: "text", text: `Invalid arguments for ${spec.definition.name}: ${detail}` }] };
      }
      try {
        const result = await spec.run(parsed.data, http, limits);
        if (!spec.whenTooLarge) return result;
        const advice = typeof spec.whenTooLarge === "string" ? spec.whenTooLarge : spec.whenTooLarge(parsed.data);
        return withinResultBudget(result, limits.maxResultBytes, advice);
      } catch (error) {
        if (error instanceof GoogleToolError) return toolErrorResult(error);
        throw error;
      }
    },
  };
}

type JsonSchemaNode = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isClosedObjectSchema(schema: JsonSchemaNode): schema is JsonSchemaNode & { properties: Record<string, JsonSchemaNode> } {
  return isRecord(schema.properties) && (schema.additionalProperties === undefined || schema.additionalProperties === false);
}

const UNMODELED_KEYWORDS = ["anyOf", "oneOf", "allOf", "not", "$ref", "prefixItems", "patternProperties", "if", "dependentSchemas", "unevaluatedProperties"];

export function unmodeledSchemaParts(schema: unknown, path: string): string[] {
  if (!isRecord(schema)) return [];
  const found = UNMODELED_KEYWORDS.filter((keyword) => keyword in schema).map((keyword) => `${path}.${keyword}`);
  if (Array.isArray(schema.items)) found.push(`${path}.items (tuple)`);
  if (isRecord(schema.properties) && schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    found.push(`${path}.additionalProperties (open beside properties)`);
  }
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  return [
    ...found,
    ...properties.flatMap(([name, item]) => unmodeledSchemaParts(item, `${path}.properties.${name}`)),
    ...unmodeledSchemaParts(schema.items, `${path}.items`),
  ];
}

export function closedObjectSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closedObjectSchema);
  if (!isRecord(schema)) return schema;
  const copy: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(schema)) {
    copy[key] = key === "properties" && isRecord(value)
      ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, closedObjectSchema(item)]))
      : key === "items" ? closedObjectSchema(value) : value;
  }
  if (isClosedObjectSchema(copy)) copy.additionalProperties = false;
  return copy;
}

function unknownArgumentProblems(value: unknown, schema: unknown, path: string): string[] {
  if (!isRecord(schema)) return [];
  if (Array.isArray(value)) {
    return isRecord(schema.items) ? value.flatMap((item, index) => unknownArgumentProblems(item, schema.items, `${path}[${index}]`)) : [];
  }
  if (!isRecord(value) || !isClosedObjectSchema(schema)) return [];
  const accepted = Object.keys(schema.properties);
  const unknown = Object.keys(value).filter((key) => value[key] !== undefined && !Object.hasOwn(schema.properties, key));
  const problems: string[] = [];
  if (unknown.length > 0) {
    const names = unknown.map((key) => JSON.stringify(key)).join(", ");
    const where = path ? ` in ${path}` : "";
    const list = accepted.length > 0 ? accepted.join(", ") : "none";
    problems.push(`unknown ${unknown.length === 1 ? "argument" : "arguments"} ${names}${where}. ${path ? `Accepted in ${path}` : "Accepted arguments"}: ${list}.`);
  }
  for (const key of accepted) {
    if (value[key] !== undefined) problems.push(...unknownArgumentProblems(value[key], schema.properties[key], path ? `${path}.${key}` : key));
  }
  return problems;
}

export function structuredResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function serializedResultBytes(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

export const byteCount = (bytes: number) => bytes.toLocaleString("en-US");

export function resultTooLargeMessage(bytes: number, maxBytes: number, advice: string): string {
  return `The result is ${byteCount(bytes)} bytes, more than the ${byteCount(maxBytes)} bytes this tool can return, so it was not returned. ${advice}`;
}

export function withinResultBudget(result: CallToolResult, maxBytes: number, advice: string): CallToolResult {
  const bytes = serializedResultBytes(result);
  if (bytes <= maxBytes) return result;
  return toolErrorResult(new GoogleToolError("too_large", resultTooLargeMessage(bytes, maxBytes, advice)));
}

export function toolErrorResult(error: GoogleToolError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: error.message }] };
}

export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

import type { ValidateFunction } from "ajv/dist/2020.js";

type SchemaNode = { type?: unknown; properties?: unknown; items?: unknown };

export type JsonValueType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export type ToolInputCoercion = {
  /** A copy of the input with each coerced field replaced by its parsed object. */
  input: unknown;
  /** JSON Pointer paths of the coerced fields, for example `/continuation`. */
  paths: string[];
};

const MAX_DEPTH = 8;

function node(schema: unknown): SchemaNode | undefined {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema) ? schema as SchemaNode : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON types a schema node declares through `type`, or null when it declares none. */
export function declaredSchemaTypes(schema: unknown): string[] | null {
  const type = node(schema)?.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type) && type.length > 0 && type.every(entry => typeof entry === "string")) return type as string[];
  return null;
}

export function jsonValueType(value: unknown): JsonValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "object") return typeof value as JsonValueType;
  return "null";
}

/** Whether a value has one of the types a schema node declares; true when it declares none. */
export function matchesDeclaredType(schema: unknown, value: unknown): boolean {
  const types = declaredSchemaTypes(schema);
  if (types === null) return true;
  const actual = jsonValueType(value);
  return types.includes(actual) || (actual === "integer" && types.includes("number"));
}

function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function coerceValue(schema: SchemaNode | undefined, value: unknown, path: string, paths: string[], depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  const types = declaredSchemaTypes(schema);
  let next = value;
  // Only a value that can never be a string is read as encoded JSON: a
  // string there is invalid, so parsing it cannot replace a valid meaning.
  if (typeof value === "string" && types?.includes("object") && !types.includes("string")) {
    const parsed = parseObject(value);
    if (parsed === null) return value;
    paths.push(path);
    next = parsed;
  }
  if (isPlainObject(next) && (types === null || types.includes("object"))) return coerceObject(schema, next, path, paths, depth);
  if (Array.isArray(next) && types?.includes("array")) {
    const items = node(schema?.items);
    if (!items) return next;
    let result = next;
    next.forEach((entry, index) => {
      const coerced = coerceValue(items, entry, `${path}/${index}`, paths, depth + 1);
      if (coerced !== entry) {
        if (result === next) result = [...next];
        result[index] = coerced;
      }
    });
    return result;
  }
  return next;
}

function coerceObject(
  schema: SchemaNode | undefined,
  value: Record<string, unknown>,
  path: string,
  paths: string[],
  depth: number,
): Record<string, unknown> {
  const properties = isPlainObject(schema?.properties) ? schema.properties : undefined;
  if (!properties || depth > MAX_DEPTH) return value;
  let result = value;
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key)) continue;
    const next = coerceValue(node(properties[key]), entry, `${path}/${escapePointer(key)}`, paths, depth + 1);
    if (next !== entry) {
      if (result === value) result = { ...value };
      result[key] = next;
    }
  }
  return result;
}

/**
 * Some model hosts send an object-typed tool argument as its JSON text, for
 * example `continuation: "{\"kind\":\"response_wake\"}"`. Returns a copy of
 * the input with each such string parsed back into the object it encodes, or
 * null when nothing qualifies. A field is coerced only when its schema
 * declares `object` and does not allow `string`, and the text parses to a
 * plain JSON object, so a valid string is never reinterpreted. The caller
 * must still validate the result before dispatching it.
 */
export function coerceJsonStringObjects(schema: unknown, input: unknown): ToolInputCoercion | null {
  if (!isPlainObject(input)) return null;
  const paths: string[] = [];
  const coerced = coerceObject(node(schema), input, "", paths, 0);
  return paths.length > 0 ? { input: coerced, paths } : null;
}

/** The run-event diagnostic recorded when a bridge accepts a coerced call. */
export const TOOL_INPUT_COERCION_DIAGNOSTIC_SCHEMA = "paperclip.runner.tool-input-coerced/v1";
/** The run-event diagnostic code a driver records a runner tool bridge diagnostic under. */
export const RUNNER_TOOL_BRIDGE_DIAGNOSTIC_CODE = "runner_tool_bridge_diagnostic";

export type AdmittedToolInput = {
  /** The arguments to dispatch: the coerced copy when coercion made them valid, otherwise what arrived. */
  args: unknown;
  schemaValid: boolean;
  /** Set only when the call was accepted because of coercion. */
  coercedPaths?: string[];
};

/**
 * Validate tool arguments, accepting an object-typed field sent as JSON text
 * when parsing it makes the whole call valid. When the call stays invalid,
 * `validator.errors` describe the parsed form, so the model is told what is
 * wrong inside the object rather than only that it arrived as text.
 */
export function admitToolInput(validator: ValidateFunction | undefined, received: unknown): AdmittedToolInput {
  if (validator === undefined) return { args: received, schemaValid: false };
  if (validator(received)) return { args: received, schemaValid: true };
  const coerced = coerceJsonStringObjects(validator.schema, received);
  if (coerced === null) return { args: received, schemaValid: false };
  if (validator(coerced.input)) return { args: coerced.input, schemaValid: true, coercedPaths: coerced.paths };
  return { args: received, schemaValid: false };
}

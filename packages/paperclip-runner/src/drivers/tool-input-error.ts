import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

type JsonSchemaNode = {
  type?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: unknown;
  description?: unknown;
};

const MAX_LISTED_FIELDS = 12;
const MAX_EXAMPLE_LENGTH = 600;

function isRootRequiredError(error: ErrorObject) {
  return error.keyword === "required" && error.instancePath === "" && error.schemaPath === "#/required";
}

function placeholder(key: string, schema: JsonSchemaNode | undefined, depth: number): unknown {
  const type = Array.isArray(schema?.type) ? schema?.type.find(entry => entry !== "null") : schema?.type;
  if (type === "object") {
    const required = Array.isArray(schema?.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    if (depth >= 2 || required.length === 0) return {};
    return Object.fromEntries(required.map(child => [child, placeholder(child, schema?.properties?.[child], depth + 1)]));
  }
  if (type === "array") return [];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return `<${key}>`;
}

function listFields(keys: string[]) {
  const shown = keys.slice(0, MAX_LISTED_FIELDS).join(", ");
  return keys.length > MAX_LISTED_FIELDS ? `${shown}, and ${keys.length - MAX_LISTED_FIELDS} more` : shown;
}

/** Return schema-owned recovery guidance without changing validation or dispatch. */
export function toolInputError(validator: ValidateFunction | undefined, input?: unknown): string {
  const errors = validator?.errors ?? [];
  const schema = validator?.schema;
  const rootSchema = typeof schema === "object" && schema !== null ? schema as JsonSchemaNode : undefined;
  const properties = rootSchema?.properties;
  const missing = [...new Set(errors.filter(isRootRequiredError)
    .map(error => error.params.missingProperty)
    .filter((key): key is string => typeof key === "string"))];
  const otherErrors = missing.length ? errors.filter(error => !isRootRequiredError(error)) : errors;
  const detail = otherErrors.map(error => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
  const guidance = new Set<string>();
  for (const error of errors) {
    if (error.keyword !== "required" || error.instancePath !== "") continue;
    const key = error.params.missingProperty;
    if (typeof key !== "string" || !properties || !Object.hasOwn(properties, key)) continue;
    const description = properties[key]?.description;
    if (typeof description === "string" && description.trim()) guidance.add(description.slice(0, 1000));
    if (guidance.size === 3) break;
  }
  const parts: string[] = [];
  if (missing.length) {
    const received = typeof input === "object" && input !== null && !Array.isArray(input) ? Object.keys(input) : [];
    const example = JSON.stringify(Object.fromEntries(missing.map(key => [key, placeholder(key, properties?.[key], 0)])));
    parts.push(`missing required field${missing.length === 1 ? "" : "s"}: ${listFields(missing)}.`);
    parts.push(received.length ? `This call included only: ${listFields(received)}.` : "This call included no fields.");
    parts.push("Send every required field together in one call, alongside the fields you already sent.");
    if (example.length <= MAX_EXAMPLE_LENGTH) parts.push(`Missing fields example: ${example}`);
  }
  if (detail) parts.push(missing.length ? `Also: ${detail}` : detail);
  const body = parts.join(" ");
  return `Invalid tool input${body ? `: ${body}` : "."}${guidance.size ? ` ${[...guidance].join(" ")}` : ""}`;
}

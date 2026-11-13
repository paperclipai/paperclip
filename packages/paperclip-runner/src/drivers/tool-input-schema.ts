import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export type ToolInputSchemaDialect = "draft-07" | "2019-09" | "2020-12";

export type ToolInputSchemaAdmission =
  | { ok: true; dialect: ToolInputSchemaDialect; schema: Record<string, unknown>; validate: ValidateFunction }
  | { ok: false; reason: "unsupported_dialect" | "uncompilable" };

const CANONICAL_DIALECTS: Record<ToolInputSchemaDialect, string> = {
  "draft-07": "http://json-schema.org/draft-07/schema#",
  "2019-09": "https://json-schema.org/draft/2019-09/schema",
  "2020-12": "https://json-schema.org/draft/2020-12/schema",
};

const compilers: Partial<Record<ToolInputSchemaDialect, Ajv | Ajv2019 | Ajv2020>> = {};

function compiler(dialect: ToolInputSchemaDialect) {
  const options = { allErrors: true, strict: false, addUsedSchema: false };
  return compilers[dialect] ??= dialect === "draft-07" ? new Ajv(options)
    : dialect === "2019-09" ? new Ajv2019(options) : new Ajv2020(options);
}

export function toolInputSchemaDialect(value: unknown): ToolInputSchemaDialect | null {
  if (value === undefined) return "2020-12";
  if (typeof value !== "string") return null;
  const match = /^https?:\/\/json-schema\.org\/(draft-07\/schema|draft\/2019-09\/schema|draft\/2020-12\/schema)#?$/.exec(value);
  if (!match) return null;
  return match[1] === "draft-07/schema" ? "draft-07" : match[1] === "draft/2019-09/schema" ? "2019-09" : "2020-12";
}

export function admitToolInputSchema(schema: Readonly<Record<string, unknown>>): ToolInputSchemaAdmission {
  const dialect = toolInputSchemaDialect(schema.$schema);
  if (dialect === null) return { ok: false, reason: "unsupported_dialect" };
  const normalized = structuredClone(schema) as Record<string, unknown>;
  if (normalized.$schema !== undefined) normalized.$schema = CANONICAL_DIALECTS[dialect];
  const ajv = compiler(dialect);
  const compiled = structuredClone(normalized);
  try {
    return { ok: true, dialect, schema: normalized, validate: ajv.compile(compiled) };
  } catch {
    return { ok: false, reason: "uncompilable" };
  } finally {
    forgetCompiledSchema(ajv, compiled);
  }
}

function forgetCompiledSchema(ajv: Ajv | Ajv2019 | Ajv2020, compiled: Record<string, unknown>): void {
  delete compiled.$id;
  ajv.removeSchema(compiled);
}

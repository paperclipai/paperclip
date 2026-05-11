import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ParsedOutput } from "./types.js";

const SENTINEL = "<!-- pipeline-output -->";
const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/;

const ajv = new (Ajv2020 as any)({ allErrors: true });
const schemaCache = new Map<string, object>();

export function extractOutput(commentBody: string): Record<string, unknown> | null {
  const sentinelIdx = commentBody.indexOf(SENTINEL);
  if (sentinelIdx === -1) return null;

  const afterSentinel = commentBody.slice(sentinelIdx + SENTINEL.length);
  const match = afterSentinel.match(JSON_FENCE_RE);
  if (!match) return null;

  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let schemasBaseDir: string | undefined;

export function setSchemasDir(dir: string): void {
  schemasBaseDir = dir;
}

export function loadSchema(schemaName: string): object {
  if (schemaCache.has(schemaName)) return schemaCache.get(schemaName)!;

  const baseDir = schemasBaseDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "schemas");
  const schemaPath = resolve(baseDir, `${schemaName}.json`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as object;
  schemaCache.set(schemaName, schema);
  return schema;
}

export function validateOutput(
  data: Record<string, unknown>,
  schema: object,
): ParsedOutput {
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (valid) {
    return { valid: true, data };
  }

  const errorMessages = validate.errors?.map((e: any) => `${e.instancePath} ${e.message}`).join("; ") ?? "unknown error";
  return { valid: false, data: null, error: errorMessages };
}

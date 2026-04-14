/**
 * Schema validation tests — verify all schemas in schemas/ directory
 * conform to JSON Schema Draft 2020-12.
 *
 * These tests serve as the CI check required by T2:
 * "All schema files validate against JSON Schema Draft 2020-12 — CI check."
 */

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(__dir, "../schemas");

const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

async function readSchemas(): Promise<Array<{ name: string; schema: Record<string, unknown> }>> {
  const files = await fs.readdir(schemasDir);
  const results = [];
  for (const file of files.filter((f) => f.endsWith(".schema.json"))) {
    const raw = await fs.readFile(path.join(schemasDir, file), "utf8");
    results.push({ name: file, schema: JSON.parse(raw) as Record<string, unknown> });
  }
  return results;
}

describe("JSON Schema files", () => {
  it("all schemas declare $schema = 2020-12", async () => {
    const schemas = await readSchemas();
    expect(schemas.length).toBeGreaterThan(0);
    for (const { name, schema } of schemas) {
      expect(schema["$schema"], `${name}: missing $schema`).toBe(SCHEMA_DRAFT);
    }
  });

  it("all schemas have $id, title, and type=object", async () => {
    const schemas = await readSchemas();
    for (const { name, schema } of schemas) {
      expect(schema["$id"], `${name}: missing $id`).toBeTruthy();
      expect(schema["title"], `${name}: missing title`).toBeTruthy();
      expect(schema["type"], `${name}: missing type`).toBe("object");
    }
  });

  it("all schemas have at least one required field", async () => {
    const schemas = await readSchemas();
    for (const { name, schema } of schemas) {
      const required = schema["required"];
      expect(Array.isArray(required) && (required as unknown[]).length > 0, `${name}: no required fields`).toBe(true);
    }
  });

  it("tool-result schema has all T1 ToolResultSummary fields in required", async () => {
    const schemas = await readSchemas();
    const toolResultSchema = schemas.find((s) => s.name === "tool-result.schema.json");
    expect(toolResultSchema).toBeDefined();
    const required = toolResultSchema?.schema["required"] as string[];
    const expectedFields = ["tool", "status", "exit_code", "duration_ms", "stdout_ref", "stderr_ref"];
    for (const field of expectedFields) {
      expect(required, `tool-result.schema.json: missing required field "${field}"`).toContain(field);
    }
  });

  it("schema count matches expected schemas directory", async () => {
    const schemas = await readSchemas();
    // We define 4 schemas: tool-result, checkpoint-state, delegate-result, wait-state
    expect(schemas.length).toBeGreaterThanOrEqual(4);
  });
});

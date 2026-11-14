import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";
import { admitToolInputSchema, TOOL_INPUT_SCHEMA_MAX_BYTES, toolInputSchemaBytes } from "./tool-input-schema.js";

type FixtureCase = {
  name: string;
  accepted: boolean;
  reason?: string;
  dialectUri?: string;
  schema: Record<string, unknown>;
  valid?: unknown[];
  invalid?: unknown[];
};

const fixtures = JSON.parse(readFileSync(new URL("../../test/fixtures/tool-input-schema-fixtures.json", import.meta.url), "utf8")) as { cases: FixtureCase[] };

describe("tool input schema admission", () => {
  it.each([Ajv, Ajv2019, Ajv2020].map(compiler => [compiler.name, compiler] as const))("refuses a valid schema over the Runner byte limit before %s compiles it", (_name, compiler) => {
    const compile = vi.spyOn(compiler.prototype, "compile");
    try {
      const $schema = compiler === Ajv ? "http://json-schema.org/draft-07/schema#"
        : compiler === Ajv2019 ? "https://json-schema.org/draft/2019-09/schema" : "https://json-schema.org/draft/2020-12/schema";
      const properties = Object.fromEntries(Array.from({ length: 6_000 }, (_, index) => [`field_${index}`, { type: "string", description: "x".repeat(64) }]));
      const schema = { $schema, type: "object", properties };
      expect(toolInputSchemaBytes(schema)).toBeGreaterThan(TOOL_INPUT_SCHEMA_MAX_BYTES);
      expect(admitToolInputSchema(schema)).toEqual({ ok: false, reason: "oversized" });
      expect(compile).not.toHaveBeenCalled();
      expect(admitToolInputSchema({ $schema, type: "object", properties: { name: { type: "string" } } }).ok).toBe(true);
      expect(compile).toHaveBeenCalledOnce();
    } finally {
      compile.mockRestore();
    }
  });

  it.each(fixtures.cases.map(fixture => [fixture.name, fixture] as const))("matches the shared fixture for %s", (_name, fixture) => {
    const admission = admitToolInputSchema(fixture.schema);
    if (!fixture.accepted) {
      expect(admission).toEqual({ ok: false, reason: fixture.reason });
      return;
    }
    if (!admission.ok) throw new Error(`expected ${fixture.name} to compile`);
    expect(admission.schema.$schema).toBe(fixture.dialectUri);
    for (const input of fixture.valid ?? []) expect(admission.validate(input)).toBe(true);
    for (const input of fixture.invalid ?? []) expect(admission.validate(input)).toBe(false);
  });

  it("compiles every accepted schema independently, including a reused $id", () => {
    const accepted = fixtures.cases.filter(fixture => fixture.accepted);
    const first = accepted.map(fixture => admitToolInputSchema(fixture.schema));
    const second = accepted.map(fixture => admitToolInputSchema(fixture.schema));
    expect([...first, ...second].every(admission => admission.ok)).toBe(true);
  });

  const dialects = [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ];

  it.each([
    ...dialects,
    "http://json-schema.org/draft-07/schema",
    "https://json-schema.org/draft/2020-12/schema#",
    "https://json-schema.org/draft/2019-09/meta/core",
    "https://json-schema.org/draft/2020-12/meta/core",
  ])("keeps every compiler usable after a schema that claims the reserved $id %s", reserved => {
    for (const $schema of dialects) admitToolInputSchema({ $schema, $id: reserved, type: "object" });
    for (const $schema of dialects) {
      const admission = admitToolInputSchema({ $schema, type: "object", properties: { name: { type: "string" } }, required: ["name"] });
      if (!admission.ok) throw new Error(`expected ${$schema} to compile after ${reserved}`);
      expect(admission.validate({ name: "site" })).toBe(true);
      expect(admission.validate({})).toBe(false);
    }
  });
});

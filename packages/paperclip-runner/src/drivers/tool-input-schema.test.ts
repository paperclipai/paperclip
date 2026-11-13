import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { admitToolInputSchema } from "./tool-input-schema.js";

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

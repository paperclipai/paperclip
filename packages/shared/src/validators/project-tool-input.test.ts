import { describe, expect, it } from "vitest";
import { createProjectToolInputJsonSchema, createProjectToolInputSchema } from "./project.js";

describe("create_project tool input", () => {
  it("requires an idempotency key", () => {
    expect(createProjectToolInputSchema.safeParse({ name: "Project" }).success).toBe(false);
    expect(createProjectToolInputSchema.safeParse({ name: "Project", idempotencyKey: "key" }).success).toBe(true);
  });

  it("converts to JSON Schema, including its record fields, with the zod that built it", () => {
    const schema = createProjectToolInputJsonSchema();
    expect(schema).toMatchObject({ type: "object", properties: { name: expect.any(Object), env: expect.any(Object) } });
    expect(schema.required).toContain("idempotencyKey");
  });
});

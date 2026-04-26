import { describe, expect, it } from "vitest";
import {
  createSecretSchema,
  envBindingPlainSchema,
  envBindingSchema,
  envBindingSecretRefSchema,
  envConfigSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "./secret.js";

describe("envBindingPlainSchema", () => {
  it("accepts a plain value binding", () => {
    expect(envBindingPlainSchema.safeParse({ type: "plain", value: "my-secret" }).success).toBe(true);
  });

  it("rejects wrong type discriminant", () => {
    expect(envBindingPlainSchema.safeParse({ type: "secret_ref", value: "x" }).success).toBe(false);
  });
});

describe("envBindingSecretRefSchema", () => {
  it("accepts a valid secret_ref binding", () => {
    const result = envBindingSecretRefSchema.safeParse({
      type: "secret_ref",
      secretId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts version as latest", () => {
    const result = envBindingSecretRefSchema.safeParse({
      type: "secret_ref",
      secretId: "00000000-0000-0000-0000-000000000001",
      version: "latest",
    });
    expect(result.success).toBe(true);
  });

  it("accepts version as a positive integer", () => {
    const result = envBindingSecretRefSchema.safeParse({
      type: "secret_ref",
      secretId: "00000000-0000-0000-0000-000000000001",
      version: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid secretId", () => {
    expect(
      envBindingSecretRefSchema.safeParse({ type: "secret_ref", secretId: "not-uuid" }).success,
    ).toBe(false);
  });

  it("rejects a zero or negative version number", () => {
    expect(
      envBindingSecretRefSchema.safeParse({
        type: "secret_ref",
        secretId: "00000000-0000-0000-0000-000000000001",
        version: 0,
      }).success,
    ).toBe(false);
  });
});

describe("envBindingSchema", () => {
  it("accepts a plain string (backward-compatible legacy format)", () => {
    expect(envBindingSchema.safeParse("inline-value").success).toBe(true);
  });

  it("accepts a plain binding object", () => {
    expect(envBindingSchema.safeParse({ type: "plain", value: "x" }).success).toBe(true);
  });

  it("accepts a secret_ref binding object", () => {
    expect(
      envBindingSchema.safeParse({
        type: "secret_ref",
        secretId: "00000000-0000-0000-0000-000000000001",
      }).success,
    ).toBe(true);
  });
});

describe("envConfigSchema", () => {
  it("accepts a record of env bindings", () => {
    const result = envConfigSchema.safeParse({
      DB_URL: "postgres://localhost/test",
      API_KEY: { type: "plain", value: "sk-test" },
      SECRET: { type: "secret_ref", secretId: "00000000-0000-0000-0000-000000000001" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty record", () => {
    expect(envConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe("createSecretSchema", () => {
  const valid = { name: "MY_SECRET", value: "supersecret" };

  it("accepts a minimal secret", () => {
    expect(createSecretSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(createSecretSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(createSecretSchema.safeParse({ ...valid, value: "" }).success).toBe(false);
  });

  it("accepts optional description and externalRef", () => {
    const result = createSecretSchema.safeParse({
      ...valid,
      description: "A description",
      externalRef: "ext-123",
    });
    expect(result.success).toBe(true);
  });
});

describe("rotateSecretSchema", () => {
  it("accepts a valid rotation", () => {
    expect(rotateSecretSchema.safeParse({ value: "new-secret" }).success).toBe(true);
  });

  it("rejects an empty value", () => {
    expect(rotateSecretSchema.safeParse({ value: "" }).success).toBe(false);
  });
});

describe("updateSecretSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateSecretSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a name update", () => {
    expect(updateSecretSchema.safeParse({ name: "NEW_NAME" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(updateSecretSchema.safeParse({ name: "" }).success).toBe(false);
  });
});

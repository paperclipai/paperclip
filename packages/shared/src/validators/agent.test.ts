import { describe, expect, it } from "vitest";
import { createAgentHireSchema, createAgentSchema, updateAgentSchema } from "./agent.js";

const baseHire = {
  name: "Quality Verifier",
  role: "engineer" as const,
  adapterType: "process" as const,
  adapterConfig: {},
};

describe("createAgentHireSchema idempotency", () => {
  it("trims an optional idempotency key", () => {
    expect(createAgentHireSchema.parse({
      ...baseHire,
      idempotencyKey: "  harness:quality-verifier:v1  ",
    }).idempotencyKey).toBe("harness:quality-verifier:v1");
  });

  it("rejects empty and overlong idempotency keys", () => {
    expect(createAgentHireSchema.safeParse({
      ...baseHire,
      idempotencyKey: "   ",
    }).success).toBe(false);
    expect(createAgentHireSchema.safeParse({
      ...baseHire,
      idempotencyKey: "x".repeat(256),
    }).success).toBe(false);
  });

  it("rejects the server-managed hire marker in create, hire, and update metadata", () => {
    const metadata = {
      _paperclipHireRequest: {
        idempotencyKey: "harness:squatted:v1",
        requestFingerprint: "f".repeat(64),
      },
    };

    expect(createAgentSchema.safeParse({ ...baseHire, metadata }).success).toBe(false);
    expect(createAgentHireSchema.safeParse({ ...baseHire, metadata }).success).toBe(false);
    expect(updateAgentSchema.safeParse({ metadata }).success).toBe(false);
  });
});

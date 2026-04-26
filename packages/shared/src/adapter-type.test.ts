import { describe, expect, it } from "vitest";
import { agentAdapterTypeSchema, optionalAgentAdapterTypeSchema } from "./adapter-type.js";

// ============================================================================
// agentAdapterTypeSchema
// ============================================================================

describe("agentAdapterTypeSchema", () => {
  it("accepts a known built-in adapter type", () => {
    const result = agentAdapterTypeSchema.safeParse("claude_local");
    expect(result.success).toBe(true);
  });

  it("accepts any non-empty string (external adapters)", () => {
    const result = agentAdapterTypeSchema.safeParse("my_custom_adapter");
    expect(result.success).toBe(true);
  });

  it("defaults to 'process' when input is undefined", () => {
    const result = agentAdapterTypeSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("process");
    }
  });

  it("trims whitespace", () => {
    const result = agentAdapterTypeSchema.safeParse("  cursor  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("cursor");
    }
  });

  it("rejects empty string", () => {
    const result = agentAdapterTypeSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only string (trimmed to empty)", () => {
    const result = agentAdapterTypeSchema.safeParse("   ");
    expect(result.success).toBe(false);
  });

  it("rejects null", () => {
    const result = agentAdapterTypeSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// optionalAgentAdapterTypeSchema
// ============================================================================

describe("optionalAgentAdapterTypeSchema", () => {
  it("accepts a valid adapter type string", () => {
    const result = optionalAgentAdapterTypeSchema.safeParse("http");
    expect(result.success).toBe(true);
  });

  it("accepts undefined (optional field)", () => {
    const result = optionalAgentAdapterTypeSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeUndefined();
    }
  });

  it("trims whitespace", () => {
    const result = optionalAgentAdapterTypeSchema.safeParse("  process  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("process");
    }
  });

  it("rejects empty string", () => {
    const result = optionalAgentAdapterTypeSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only string (trimmed to empty)", () => {
    const result = optionalAgentAdapterTypeSchema.safeParse("   ");
    expect(result.success).toBe(false);
  });
});

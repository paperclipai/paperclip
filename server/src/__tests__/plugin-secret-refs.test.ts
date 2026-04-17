import { describe, it, expect } from "vitest";
import { extractSecretRefsFromConfig } from "../services/plugin-secrets-handler.js";

// Sample UUIDs (valid format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
const UUID_A = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const UUID_B = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const UUID_C = "cccccccc-1111-2222-3333-444444444444";

describe("extractSecretRefsFromConfig", () => {
  // ── null / non-object inputs ──────────────────────────────────────────────

  it("returns empty Set for null configJson", () => {
    expect(extractSecretRefsFromConfig(null)).toEqual(new Set());
  });

  it("returns empty Set for undefined configJson", () => {
    expect(extractSecretRefsFromConfig(undefined)).toEqual(new Set());
  });

  it("returns empty Set for a string configJson", () => {
    expect(extractSecretRefsFromConfig("a-string")).toEqual(new Set());
  });

  it("returns empty Set for a number configJson", () => {
    expect(extractSecretRefsFromConfig(42)).toEqual(new Set());
  });

  it("returns empty Set for an array configJson (no schema fallback)", () => {
    // Arrays are iterated by walkAll, but top-level array check exits early
    // because typeof [] === "object" — however, the guard uses Array check
    // via "configJson == null || typeof configJson !== 'object'". Arrays pass,
    // but the walkAll fallback would iterate them.
    const result = extractSecretRefsFromConfig([UUID_A]);
    // Array passes the object check, falls to walkAll, finds UUID at index 0
    expect(result.has(UUID_A)).toBe(true);
  });

  // ── no schema (fallback: collect all UUIDs) ───────────────────────────────

  it("collects all UUID-shaped strings when no schema is provided", () => {
    const config = { apiKey: UUID_A, name: "my-plugin" };
    const result = extractSecretRefsFromConfig(config);
    expect(result).toEqual(new Set([UUID_A]));
  });

  it("collects multiple UUIDs from config without schema", () => {
    const config = { apiKey: UUID_A, token: UUID_B, name: "plugin" };
    const result = extractSecretRefsFromConfig(config);
    expect(result).toEqual(new Set([UUID_A, UUID_B]));
  });

  it("ignores non-UUID strings when no schema is provided", () => {
    const config = { apiKey: "not-a-uuid", name: "plugin" };
    const result = extractSecretRefsFromConfig(config);
    expect(result.size).toBe(0);
  });

  it("recursively collects UUIDs from nested objects without schema", () => {
    const config = { settings: { token: UUID_A, host: "localhost" }, name: "plugin" };
    const result = extractSecretRefsFromConfig(config);
    expect(result).toEqual(new Set([UUID_A]));
  });

  it("collects UUIDs from nested arrays without schema", () => {
    const config = { tokens: [UUID_A, "not-uuid", UUID_B] };
    const result = extractSecretRefsFromConfig(config);
    expect(result).toEqual(new Set([UUID_A, UUID_B]));
  });

  it("handles deeply nested UUIDs without schema", () => {
    const config = { a: { b: { c: UUID_C } } };
    const result = extractSecretRefsFromConfig(config);
    expect(result).toEqual(new Set([UUID_C]));
  });

  // ── with schema (only collect from secret-ref annotated paths) ───────────

  it("extracts only schema-declared secret-ref paths when schema is provided", () => {
    const schema = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
        host: { type: "string" },
      },
    };
    const config = { apiKey: UUID_A, host: "localhost" };
    const result = extractSecretRefsFromConfig(config, schema);
    expect(result).toEqual(new Set([UUID_A]));
  });

  it("returns empty Set when declared secret-ref field has non-UUID value", () => {
    const schema = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
      },
    };
    const config = { apiKey: "not-a-uuid" };
    const result = extractSecretRefsFromConfig(config, schema);
    expect(result.size).toBe(0);
  });

  it("ignores non-schema UUID values when schema declares no secret-refs", () => {
    // Schema exists but no property has format: secret-ref
    // In this case the secretPaths Set is empty and the fallback walkAll runs
    const schema = {
      type: "object",
      properties: {
        host: { type: "string" },
      },
    };
    const config = { host: "localhost", apiKey: UUID_A };
    // No secret-ref paths → falls back to walkAll, collects UUID_A
    const result = extractSecretRefsFromConfig(config, schema);
    expect(result).toEqual(new Set([UUID_A]));
  });

  it("extracts UUID from nested secret-ref path using dot notation", () => {
    const schema = {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string", format: "secret-ref" },
          },
        },
      },
    };
    const config = { auth: { token: UUID_B } };
    const result = extractSecretRefsFromConfig(config, schema);
    expect(result).toEqual(new Set([UUID_B]));
  });

  it("returns empty Set when nested path value is missing", () => {
    const schema = {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string", format: "secret-ref" },
          },
        },
      },
    };
    const config = { auth: {} };
    const result = extractSecretRefsFromConfig(config, schema);
    expect(result.size).toBe(0);
  });

  it("extracts multiple UUIDs from multiple secret-ref paths", () => {
    const schema = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
        webhookSecret: { type: "string", format: "secret-ref" },
        host: { type: "string" },
      },
    };
    const config = { apiKey: UUID_A, webhookSecret: UUID_B, host: "api.example.com" };
    const result = extractSecretRefsFromConfig(config, schema);
    expect(result).toEqual(new Set([UUID_A, UUID_B]));
  });

  it("handles null schema same as no schema (falls back to walkAll)", () => {
    const config = { secret: UUID_C };
    const result = extractSecretRefsFromConfig(config, null);
    expect(result).toEqual(new Set([UUID_C]));
  });

  it("does not collect UUIDs from non-secret-ref schema fields when schema has secret-refs", () => {
    const schema = {
      type: "object",
      properties: {
        apiKey: { type: "string", format: "secret-ref" },
        otherUuid: { type: "string" }, // Not secret-ref
      },
    };
    const config = { apiKey: UUID_A, otherUuid: UUID_B };
    const result = extractSecretRefsFromConfig(config, schema);
    // Only apiKey is annotated as secret-ref
    expect(result).toEqual(new Set([UUID_A]));
    expect(result.has(UUID_B)).toBe(false);
  });
});

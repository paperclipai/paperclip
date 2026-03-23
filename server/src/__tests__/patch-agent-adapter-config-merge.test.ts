import { describe, expect, it } from "vitest";

/**
 * Unit tests for the adapterConfig merge logic in PATCH /agents/:id.
 *
 * The merge follows RFC 7396 (JSON Merge Patch) semantics:
 *   - Missing keys in the patch are preserved from the existing config.
 *   - Explicit null values remove the key from the result.
 *   - Provided keys overwrite existing values.
 */

function mergeAdapterConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...incoming };
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== null) result[k] = v;
  }
  return result;
}

describe("PATCH /agents/:id adapterConfig merge", () => {
  it("preserves existing fields not present in the patch", () => {
    const existing = {
      url: "https://gateway.example.com",
      headers: { Authorization: "Bearer secret" },
      scopes: ["read", "write"],
      waitTimeoutMs: 30000,
    };
    const incoming = {
      paperclipApiUrl: "http://127.0.0.1:3100/",
    };

    const result = mergeAdapterConfig(existing, incoming);

    expect(result).toEqual({
      url: "https://gateway.example.com",
      headers: { Authorization: "Bearer secret" },
      scopes: ["read", "write"],
      waitTimeoutMs: 30000,
      paperclipApiUrl: "http://127.0.0.1:3100/",
    });
  });

  it("overwrites existing fields with new values", () => {
    const existing = {
      url: "https://old.example.com",
      waitTimeoutMs: 30000,
    };
    const incoming = {
      url: "https://new.example.com",
    };

    const result = mergeAdapterConfig(existing, incoming);

    expect(result.url).toBe("https://new.example.com");
    expect(result.waitTimeoutMs).toBe(30000);
  });

  it("removes fields set to null (RFC 7396)", () => {
    const existing = {
      url: "https://gateway.example.com",
      headers: { Authorization: "Bearer secret" },
      scopes: ["read", "write"],
    };
    const incoming = {
      scopes: null,
    };

    const result = mergeAdapterConfig(existing, incoming);

    expect(result).toEqual({
      url: "https://gateway.example.com",
      headers: { Authorization: "Bearer secret" },
    });
    expect(result).not.toHaveProperty("scopes");
  });

  it("handles empty incoming (no adapterConfig in body)", () => {
    const existing = {
      url: "https://gateway.example.com",
      waitTimeoutMs: 30000,
    };
    const incoming = {};

    const result = mergeAdapterConfig(existing, incoming);

    expect(result).toEqual(existing);
  });

  it("handles empty existing config", () => {
    const existing = {};
    const incoming = {
      url: "https://new.example.com",
      waitTimeoutMs: 60000,
    };

    const result = mergeAdapterConfig(existing, incoming);

    expect(result).toEqual(incoming);
  });

  it("handles mixed: add, update, remove in one patch", () => {
    const existing = {
      url: "https://old.example.com",
      headers: { Authorization: "Bearer old" },
      scopes: ["read"],
      waitTimeoutMs: 30000,
    };
    const incoming = {
      url: "https://new.example.com",
      scopes: null,
      paperclipApiUrl: "http://127.0.0.1:3100/",
    };

    const result = mergeAdapterConfig(existing, incoming);

    expect(result).toEqual({
      url: "https://new.example.com",
      headers: { Authorization: "Bearer old" },
      waitTimeoutMs: 30000,
      paperclipApiUrl: "http://127.0.0.1:3100/",
    });
  });
});

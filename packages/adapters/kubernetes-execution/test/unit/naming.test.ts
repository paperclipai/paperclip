import { describe, it, expect } from "vitest";
import { deriveNamespaceName, isValidDns1123Label } from "../../src/orchestrator/naming.js";

describe("isValidDns1123Label", () => {
  it("accepts simple slugs", () => {
    expect(isValidDns1123Label("acme-corp")).toBe(true);
    expect(isValidDns1123Label("a")).toBe(true);
  });
  it("rejects uppercase, leading/trailing hyphens, dots, length > 63", () => {
    expect(isValidDns1123Label("Acme")).toBe(false);
    expect(isValidDns1123Label("-acme")).toBe(false);
    expect(isValidDns1123Label("acme-")).toBe(false);
    expect(isValidDns1123Label("ac.me")).toBe(false);
    expect(isValidDns1123Label("x".repeat(64))).toBe(false);
  });
});

describe("deriveNamespaceName", () => {
  it("returns paperclip-{slug} for short clean slugs", () => {
    expect(deriveNamespaceName({
      companySlug: "acme-corp",
      companyId: "11111111-1111-1111-1111-111111111111",
      prefix: "paperclip-",
    })).toBe("paperclip-acme-corp");
  });

  it("appends a short hash when the slug overflows after prefix", () => {
    const longSlug = "a".repeat(60);
    const result = deriveNamespaceName({
      companySlug: longSlug,
      companyId: "22222222-2222-2222-2222-222222222222",
      prefix: "paperclip-",
    });
    expect(result.startsWith("paperclip-")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result).toMatch(/-[0-9a-z]{8}$/);
  });

  it("appends a short hash when explicit collision flag is set", () => {
    const withHash = deriveNamespaceName({
      companySlug: "acme-corp",
      companyId: "33333333-3333-3333-3333-333333333333",
      prefix: "paperclip-",
      collisionFallback: true,
    });
    expect(withHash).toMatch(/^paperclip-acme-corp-[0-9a-z]{8}$/);
  });

  it("sanitizes invalid slugs deterministically and produces a DNS-1123 label", () => {
    const r = deriveNamespaceName({
      companySlug: "Acme Corp.!",
      companyId: "44444444-4444-4444-4444-444444444444",
      prefix: "paperclip-",
    });
    expect(isValidDns1123Label(r)).toBe(true);
    expect(r.startsWith("paperclip-")).toBe(true);
  });

  it("produces a stable result for the same companyId across calls", () => {
    const a = deriveNamespaceName({
      companySlug: "acme-corp", companyId: "55555555-5555-5555-5555-555555555555",
      prefix: "paperclip-", collisionFallback: true,
    });
    const b = deriveNamespaceName({
      companySlug: "acme-corp", companyId: "55555555-5555-5555-5555-555555555555",
      prefix: "paperclip-", collisionFallback: true,
    });
    expect(a).toBe(b);
  });

  it("produces different hash suffixes for different companyIds with the same slug", () => {
    const a = deriveNamespaceName({
      companySlug: "acme-corp", companyId: "11111111-1111-1111-1111-111111111111",
      prefix: "paperclip-", collisionFallback: true,
    });
    const b = deriveNamespaceName({
      companySlug: "acme-corp", companyId: "22222222-2222-2222-2222-222222222222",
      prefix: "paperclip-", collisionFallback: true,
    });
    expect(a).not.toBe(b);
  });

  it("returns a valid label even when the slug becomes empty after sanitization", () => {
    const r = deriveNamespaceName({
      companySlug: "!!!",
      companyId: "66666666-6666-6666-6666-666666666666",
      prefix: "paperclip-",
    });
    expect(isValidDns1123Label(r)).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { deriveCompanySlug, deriveNamespaceName, newRunUlidDns, paperclipLabels } from "../../src/utils.js";

describe("deriveCompanySlug", () => {
  it("lowercases and replaces non-alphanumerics", () => {
    expect(deriveCompanySlug("Acme Co!")).toBe("acme-co");
  });

  it("truncates to 32 chars and strips trailing dashes", () => {
    expect(deriveCompanySlug("A".repeat(50))).toBe("a".repeat(32));
    expect(deriveCompanySlug("ab---")).toBe("ab");
  });

  it("falls back to 'company' on empty/zero-letter input", () => {
    expect(deriveCompanySlug("!!!")).toBe("company");
    expect(deriveCompanySlug("")).toBe("company");
  });
});

describe("deriveNamespaceName", () => {
  it("concatenates prefix and slug", () => {
    expect(deriveNamespaceName("paperclip-", "acme-co")).toBe("paperclip-acme-co");
  });
});

describe("newRunUlidDns", () => {
  it("produces a DNS-safe 26-char lowercase id", () => {
    const id = newRunUlidDns();
    expect(id).toMatch(/^[a-z0-9]{26}$/);
  });
});

describe("paperclipLabels", () => {
  it("returns canonical label map", () => {
    const labels = paperclipLabels({ runId: "r1", agentId: "a1", companyId: "c1", adapterType: "claude_local" });
    expect(labels["paperclip.io/run-id"]).toBe("r1");
    expect(labels["paperclip.io/agent-id"]).toBe("a1");
    expect(labels["paperclip.io/company-id"]).toBe("c1");
    expect(labels["paperclip.io/adapter"]).toBe("claude_local");
    expect(labels["paperclip.io/managed-by"]).toBe("paperclip-k8s-plugin");
  });
});

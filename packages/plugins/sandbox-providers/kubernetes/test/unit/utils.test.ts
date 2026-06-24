import { describe, it, expect } from "vitest";
import { deriveCompanySlug, deriveNamespaceName, newRunUlidDns, paperclipLabels } from "../../src/utils.js";

describe("deriveCompanySlug", () => {
  it("lowercases and replaces non-alphanumerics", () => {
    expect(deriveCompanySlug("Acme Co!")).toBe("acme-co");
  });

  it("preserves long inputs within the namespace budget instead of blind truncation", () => {
    const input = "a".repeat(40) + "-suffix-that-pushes-past-the-budget";
    const slug = deriveCompanySlug(input);
    expect(slug.length).toBeLessThanOrEqual(53);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back to 'company' on empty/zero-letter input", () => {
    expect(deriveCompanySlug("!!!")).toBe("company");
    expect(deriveCompanySlug("")).toBe("company");
  });
  it("keeps full UUIDs untruncated so distinct companies never share a slug", () => {
    const a = deriveCompanySlug("0d9c52f6-2f30-4d3e-9a01-aaaaaaaa0001");
    const b = deriveCompanySlug("0d9c52f6-2f30-4d3e-9a01-aaaaaaaa0002");
    expect(a).toBe("0d9c52f6-2f30-4d3e-9a01-aaaaaaaa0001");
    expect(a).not.toBe(b);
  });

  it("appends a hash of the full input when the slug exceeds the namespace budget", () => {
    const long1 = "x".repeat(60) + "-tail-one";
    const long2 = "x".repeat(60) + "-tail-two";
    const s1 = deriveCompanySlug(long1);
    const s2 = deriveCompanySlug(long2);
    expect(s1.length).toBeLessThanOrEqual(53);
    expect(s2.length).toBeLessThanOrEqual(53);
    expect(s1).not.toBe(s2);
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

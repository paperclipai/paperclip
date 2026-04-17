import { describe, expect, it } from "vitest";
import { normalizeHostnameInput, parseHostnameCsv } from "./hostnames.js";

// ============================================================================
// normalizeHostnameInput
// ============================================================================

describe("normalizeHostnameInput", () => {
  it("returns the hostname from a bare hostname string", () => {
    expect(normalizeHostnameInput("example.com")).toBe("example.com");
  });

  it("strips the scheme from a full URL", () => {
    expect(normalizeHostnameInput("https://example.com")).toBe("example.com");
  });

  it("strips the scheme and port from a full URL", () => {
    expect(normalizeHostnameInput("http://example.com:8080")).toBe("example.com");
  });

  it("lowercases the hostname", () => {
    expect(normalizeHostnameInput("EXAMPLE.COM")).toBe("example.com");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeHostnameInput("  example.com  ")).toBe("example.com");
  });

  it("handles localhost", () => {
    expect(normalizeHostnameInput("localhost")).toBe("localhost");
  });

  it("handles an IP address", () => {
    expect(normalizeHostnameInput("127.0.0.1")).toBe("127.0.0.1");
  });

  it("throws for an empty string", () => {
    expect(() => normalizeHostnameInput("")).toThrow("Hostname is required");
  });

  it("throws for whitespace-only string", () => {
    expect(() => normalizeHostnameInput("   ")).toThrow("Hostname is required");
  });
});

// ============================================================================
// parseHostnameCsv
// ============================================================================

describe("parseHostnameCsv", () => {
  it("returns an empty array for an empty string", () => {
    expect(parseHostnameCsv("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(parseHostnameCsv("   ")).toEqual([]);
  });

  it("parses a single hostname", () => {
    expect(parseHostnameCsv("example.com")).toEqual(["example.com"]);
  });

  it("parses multiple comma-separated hostnames", () => {
    const result = parseHostnameCsv("example.com,api.example.com");
    expect(result).toContain("example.com");
    expect(result).toContain("api.example.com");
    expect(result).toHaveLength(2);
  });

  it("deduplicates identical hostnames", () => {
    const result = parseHostnameCsv("example.com,example.com");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("example.com");
  });

  it("normalizes hostnames (lowercases)", () => {
    const result = parseHostnameCsv("EXAMPLE.COM");
    expect(result).toEqual(["example.com"]);
  });

  it("handles full URLs in the CSV", () => {
    const result = parseHostnameCsv("https://example.com");
    expect(result).toEqual(["example.com"]);
  });
});

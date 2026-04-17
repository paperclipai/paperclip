import { describe, it, expect } from "vitest";
import { normalizeHostnameInput, parseHostnameCsv } from "../config/hostnames.js";

// ---------------------------------------------------------------------------
// normalizeHostnameInput
// ---------------------------------------------------------------------------

describe("normalizeHostnameInput", () => {
  it("returns the hostname for a plain hostname string", () => {
    expect(normalizeHostnameInput("localhost")).toBe("localhost");
  });

  it("extracts the hostname from an http:// URL", () => {
    expect(normalizeHostnameInput("http://example.com")).toBe("example.com");
  });

  it("extracts the hostname from an https:// URL", () => {
    expect(normalizeHostnameInput("https://myapp.example.com")).toBe("myapp.example.com");
  });

  it("lowercases the hostname", () => {
    expect(normalizeHostnameInput("Example.COM")).toBe("example.com");
  });

  it("trims whitespace from the input before processing", () => {
    expect(normalizeHostnameInput("  example.com  ")).toBe("example.com");
  });

  it("returns the IP address for a raw IP input", () => {
    expect(normalizeHostnameInput("127.0.0.1")).toBe("127.0.0.1");
  });

  it("throws for an empty string", () => {
    expect(() => normalizeHostnameInput("")).toThrow();
  });

  it("throws for a whitespace-only string", () => {
    expect(() => normalizeHostnameInput("   ")).toThrow();
  });

  it("throws for a URL with only a scheme and no host", () => {
    expect(() => normalizeHostnameInput("://")).toThrow();
  });

  it("strips the port from a hostname:port input", () => {
    expect(normalizeHostnameInput("example.com:3000")).toBe("example.com");
  });

  it("strips the port from a URL with a port", () => {
    expect(normalizeHostnameInput("http://example.com:8080")).toBe("example.com");
  });

  it("strips the path from a URL", () => {
    expect(normalizeHostnameInput("http://example.com/some/path")).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
// parseHostnameCsv
// ---------------------------------------------------------------------------

describe("parseHostnameCsv", () => {
  it("returns an empty array for an empty string", () => {
    expect(parseHostnameCsv("")).toEqual([]);
  });

  it("returns an empty array for a whitespace-only string", () => {
    expect(parseHostnameCsv("   ")).toEqual([]);
  });

  it("parses a single hostname", () => {
    expect(parseHostnameCsv("example.com")).toEqual(["example.com"]);
  });

  it("parses multiple hostnames", () => {
    expect(parseHostnameCsv("example.com,other.com")).toEqual(["example.com", "other.com"]);
  });

  it("deduplicates identical hostnames", () => {
    expect(parseHostnameCsv("example.com,example.com")).toEqual(["example.com"]);
  });

  it("lowercases all hostnames", () => {
    expect(parseHostnameCsv("Example.COM,Other.NET")).toEqual(["example.com", "other.net"]);
  });

  it("trims whitespace around individual hostnames", () => {
    // normalizeHostnameInput trims per-part whitespace
    expect(parseHostnameCsv(" example.com , other.com ")).toEqual(["example.com", "other.com"]);
  });

  it("parses URLs embedded in the CSV", () => {
    expect(parseHostnameCsv("https://example.com,http://other.com")).toEqual(["example.com", "other.com"]);
  });

  it("throws when any hostname in the CSV is invalid", () => {
    expect(() => parseHostnameCsv("example.com,://")).toThrow();
  });
});

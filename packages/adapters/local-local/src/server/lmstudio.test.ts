import { describe, expect, it } from "vitest";
import { resolveBaseUrl } from "./lmstudio.js";

describe("resolveBaseUrl", () => {
  it("returns the default URL when config is undefined", () => {
    expect(resolveBaseUrl(undefined)).toBe("http://127.0.0.1:1234/v1");
  });

  it("returns the default URL when config is empty string", () => {
    expect(resolveBaseUrl("")).toBe("http://127.0.0.1:1234/v1");
  });

  it("returns the default URL when config is whitespace", () => {
    expect(resolveBaseUrl("   ")).toBe("http://127.0.0.1:1234/v1");
  });

  it("returns the default URL when config is null", () => {
    expect(resolveBaseUrl(null)).toBe("http://127.0.0.1:1234/v1");
  });

  it("returns the default URL when config is a number", () => {
    expect(resolveBaseUrl(42)).toBe("http://127.0.0.1:1234/v1");
  });

  it("uses the configured URL when provided", () => {
    expect(resolveBaseUrl("http://192.168.1.100:1234/v1")).toBe("http://192.168.1.100:1234/v1");
  });

  it("trims whitespace from configured URL", () => {
    expect(resolveBaseUrl("  http://localhost:1234/v1  ")).toBe("http://localhost:1234/v1");
  });

  it("strips trailing slashes from configured URL", () => {
    expect(resolveBaseUrl("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
  });

  it("strips multiple trailing slashes", () => {
    expect(resolveBaseUrl("http://localhost:1234/v1///")).toBe("http://localhost:1234/v1");
  });
});

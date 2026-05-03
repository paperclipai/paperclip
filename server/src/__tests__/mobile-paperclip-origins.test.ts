import { describe, expect, it } from "vitest";
import { buildOriginMatcher, parseOriginAllowlistEnv } from "../mobile-paperclip-origins.js";

describe("buildOriginMatcher", () => {
  it("matches an exact origin", () => {
    const matcher = buildOriginMatcher(["https://mobilepaperclip.vercel.app"]);
    expect(matcher.match("https://mobilepaperclip.vercel.app")).toBe("https://mobilepaperclip.vercel.app");
  });

  it("rejects http when only https is configured", () => {
    const matcher = buildOriginMatcher(["https://mobilepaperclip.vercel.app"]);
    expect(matcher.match("http://mobilepaperclip.vercel.app")).toBeNull();
  });

  it("matches a single-label wildcard pattern", () => {
    const matcher = buildOriginMatcher(["https://*.vercel.app"]);
    expect(matcher.match("https://mobilepaperclip.vercel.app")).toBe(
      "https://mobilepaperclip.vercel.app",
    );
    expect(matcher.match("https://feature-branch-deploy.vercel.app")).toBe(
      "https://feature-branch-deploy.vercel.app",
    );
  });

  it("does not let the wildcard span dots", () => {
    const matcher = buildOriginMatcher(["https://*.vercel.app"]);
    expect(matcher.match("https://attacker.evil.com.vercel.app")).toBeNull();
    expect(matcher.match("https://attacker.evil.com")).toBeNull();
  });

  it("returns null for empty/malformed origin headers", () => {
    const matcher = buildOriginMatcher(["https://mobilepaperclip.vercel.app"]);
    expect(matcher.match(undefined)).toBeNull();
    expect(matcher.match(null)).toBeNull();
    expect(matcher.match("")).toBeNull();
    expect(matcher.match("not-a-url")).toBeNull();
    expect(matcher.match("file:///etc/passwd")).toBeNull();
  });

  it("ignores invalid patterns silently", () => {
    const matcher = buildOriginMatcher(["", "not-a-url", "https://valid.example.com"]);
    expect(matcher.configuredPatterns).toEqual(["https://valid.example.com"]);
    expect(matcher.match("https://valid.example.com")).toBe("https://valid.example.com");
  });

  it("normalizes the returned origin (lowercase, no trailing slash)", () => {
    const matcher = buildOriginMatcher(["https://mobilepaperclip.vercel.app"]);
    expect(matcher.match("HTTPS://Mobilepaperclip.Vercel.App")).toBe(
      "https://mobilepaperclip.vercel.app",
    );
  });

  it("matches with explicit ports when configured", () => {
    const matcher = buildOriginMatcher(["http://localhost:5173"]);
    expect(matcher.match("http://localhost:5173")).toBe("http://localhost:5173");
    expect(matcher.match("http://localhost:5174")).toBeNull();
  });

  it("rejects non-default ports for patterns with no explicit port", () => {
    const matcher = buildOriginMatcher(["https://mobilepaperclip.vercel.app"]);
    expect(matcher.match("https://mobilepaperclip.vercel.app:8080")).toBeNull();
    expect(matcher.match("https://mobilepaperclip.vercel.app:443")).toBe(
      "https://mobilepaperclip.vercel.app",
    );
    expect(matcher.match("https://mobilepaperclip.vercel.app")).toBe(
      "https://mobilepaperclip.vercel.app",
    );
  });

  it("rejects non-default ports for wildcard patterns with no explicit port", () => {
    const matcher = buildOriginMatcher(["https://*.vercel.app"]);
    expect(matcher.match("https://feature.vercel.app:8080")).toBeNull();
    expect(matcher.match("https://feature.vercel.app")).toBe(
      "https://feature.vercel.app",
    );
  });
});

describe("parseOriginAllowlistEnv", () => {
  it("splits and trims a comma-separated list", () => {
    expect(
      parseOriginAllowlistEnv(" https://a.example.com , https://b.example.com ,, "),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("returns an empty list when undefined", () => {
    expect(parseOriginAllowlistEnv(undefined)).toEqual([]);
    expect(parseOriginAllowlistEnv("")).toEqual([]);
  });
});

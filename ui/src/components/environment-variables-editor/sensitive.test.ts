import { describe, expect, it } from "vitest";
import { isSensitiveEnv } from "./sensitive";

describe("isSensitiveEnv", () => {
  it("is false for an empty value regardless of name", () => {
    expect(isSensitiveEnv("API_KEY", "")).toBe(false);
  });

  it("flags credential-shaped names (regex shared with the server migration)", () => {
    expect(isSensitiveEnv("STRIPE_API_KEY", "x")).toBe(true);
    expect(isSensitiveEnv("DB_PASSWORD", "x")).toBe(true);
    expect(isSensitiveEnv("MY_SECRET", "x")).toBe(true);
    expect(isSensitiveEnv("ACCESS_TOKEN", "x")).toBe(true);
    expect(isSensitiveEnv("GH_AUTH_TOKEN", "x")).toBe(true);
  });

  it("does not flag benign names with short values", () => {
    expect(isSensitiveEnv("NODE_ENV", "production")).toBe(false);
    expect(isSensitiveEnv("PORT", "3000")).toBe(false);
    // A bare `TOKEN` in the name is intentionally NOT matched by name alone
    // (the server regex only matches access_token / auth_token).
    expect(isSensitiveEnv("GH_TOKEN", "short")).toBe(false);
  });

  it("flags known credential value shapes even with benign names", () => {
    expect(isSensitiveEnv("CONFIG", "sk-abcdefghijklmnopqrst")).toBe(true);
    expect(isSensitiveEnv("CONFIG", "ghp_0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isSensitiveEnv("CONFIG", "xoxb-123456789012-abcdefghijkl")).toBe(true);
    expect(isSensitiveEnv("CONFIG", "-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("flags long high-entropy tokens", () => {
    expect(isSensitiveEnv("CONFIG", "aB3xY7zQ9mN2pR5tK8wL1vC4")).toBe(true);
  });

  it("does not flag long lowercase-only prose/paths", () => {
    expect(isSensitiveEnv("PATH", "/usr/local/bin/some/long/path/here")).toBe(false);
    expect(isSensitiveEnv("GREETING", "hello there this is a message")).toBe(false);
  });
});

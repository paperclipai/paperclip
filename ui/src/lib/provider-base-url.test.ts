import { describe, expect, it } from "vitest";
import {
  applyBaseUrlToEnv,
  baseUrlEnvKeyFor,
  normalizeBaseUrl,
  validateBaseUrl,
} from "./provider-base-url";

describe("provider-base-url", () => {
  it("maps adapters to their endpoint env var", () => {
    expect(baseUrlEnvKeyFor("claude_local")).toBe("ANTHROPIC_BASE_URL");
    expect(baseUrlEnvKeyFor("codex_local")).toBe("OPENAI_BASE_URL");
    expect(baseUrlEnvKeyFor("gemini_local")).toBeNull();
  });

  it("validates http(s) URLs", () => {
    expect(validateBaseUrl("  http://localhost:20128/v1 ")).toBeNull();
    expect(validateBaseUrl("")).toBeNull();
    expect(validateBaseUrl("localhost:20128")).toBe("Please enter a valid URL, or leave blank for the default endpoint.");
    expect(validateBaseUrl("ftp://example.com")).toBe("URL must start with http:// or https://");
  });

  it("normalizes and accepts only valid URLs", () => {
    expect(normalizeBaseUrl("  http://localhost:20128/v1 ")).toBe("http://localhost:20128/v1");
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("localhost:20128")).toBeNull();
    expect(normalizeBaseUrl("ftp://example.com")).toBeNull();
  });

  it("applies a plain binding without mutating the input", () => {
    const env = { FOO: "bar" };
    expect(applyBaseUrlToEnv(env, "codex_local", "http://localhost:20128/v1")).toEqual({
      FOO: "bar",
      OPENAI_BASE_URL: { type: "plain", value: "http://localhost:20128/v1" },
    });
    expect(env).toEqual({ FOO: "bar" });
  });

  it("is a no-op for unsupported adapters or empty values", () => {
    const env = { FOO: "bar" };
    expect(applyBaseUrlToEnv(env, "gemini_local", "http://x")).toBe(env);
    expect(applyBaseUrlToEnv(env, "claude_local", "")).toBe(env);
  });
});

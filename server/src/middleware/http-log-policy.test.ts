import { describe, expect, it } from "vitest";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";

// ============================================================================
// shouldSilenceHttpSuccessLog
// ============================================================================

describe("shouldSilenceHttpSuccessLog", () => {
  // Error and redirect responses
  it("does not silence 4xx responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 404)).toBe(false);
  });

  it("does not silence 5xx responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 500)).toBe(false);
  });

  it("silences 304 Not Modified responses", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/some-path", 304)).toBe(true);
  });

  // Method filtering
  it("does not silence POST requests", () => {
    expect(shouldSilenceHttpSuccessLog("POST", "/api/health", 200)).toBe(false);
  });

  it("does not silence PATCH requests", () => {
    expect(shouldSilenceHttpSuccessLog("PATCH", "/api/issues/123", 200)).toBe(false);
  });

  it("silences GET requests to silenced paths", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
  });

  it("silences HEAD requests to silenced paths", () => {
    expect(shouldSilenceHttpSuccessLog("HEAD", "/api/health", 200)).toBe(true);
  });

  it("is case-insensitive for method", () => {
    expect(shouldSilenceHttpSuccessLog("get", "/api/health", 200)).toBe(true);
  });

  // Static file paths
  it("silences /favicon.ico", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/favicon.ico", 200)).toBe(true);
  });

  it("silences /site.webmanifest", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/site.webmanifest", 200)).toBe(true);
  });

  it("silences /sw.js", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/sw.js", 200)).toBe(true);
  });

  // Static prefixes
  it("silences /assets/ prefix", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/assets/main.js", 200)).toBe(true);
  });

  it("silences /@vite/ prefix", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/@vite/client", 200)).toBe(true);
  });

  it("silences /_plugins/ prefix", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/_plugins/my-plugin/ui/index.js", 200)).toBe(true);
  });

  it("silences /src/ prefix", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/src/lib/utils.ts", 200)).toBe(true);
  });

  // API paths
  it("silences GET /api/health", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health", 200)).toBe(true);
  });

  it("silences GET /api/health/ with trailing slash", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health/", 200)).toBe(true);
  });

  it("silences GET /api/companies/:id/activity", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/comp-123/activity", 200)).toBe(true);
  });

  it("silences GET /api/companies/:id/dashboard", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/comp-123/dashboard", 200)).toBe(true);
  });

  it("silences GET /api/companies/:id/sidebar-badges", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/comp-123/sidebar-badges", 200)).toBe(true);
  });

  it("silences GET /api/companies/:id/live-runs", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/comp-123/live-runs", 200)).toBe(true);
  });

  it("silences GET /api/heartbeat-runs/:id/log", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/heartbeat-runs/run-123/log", 200)).toBe(true);
  });

  // Non-silenced API paths
  it("does not silence GET /api/agents", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/agents", 200)).toBe(false);
  });

  it("does not silence GET /api/companies/:id/agents", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/companies/comp-123/agents", 200)).toBe(false);
  });

  // Null/undefined handling
  it("does not silence when method is undefined", () => {
    expect(shouldSilenceHttpSuccessLog(undefined, "/api/health", 200)).toBe(false);
  });

  it("does not silence when url is undefined", () => {
    expect(shouldSilenceHttpSuccessLog("GET", undefined, 200)).toBe(false);
  });

  // URL with query strings
  it("ignores query string when matching paths", () => {
    expect(shouldSilenceHttpSuccessLog("GET", "/api/health?verbose=true", 200)).toBe(true);
  });
});

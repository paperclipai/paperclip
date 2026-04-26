import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTelemetryConfig } from "./config.js";

describe("resolveTelemetryConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("disables telemetry when PAPERCLIP_TELEMETRY_DISABLED=1", () => {
    vi.stubEnv("PAPERCLIP_TELEMETRY_DISABLED", "1");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when DO_NOT_TRACK=1", () => {
    vi.stubEnv("DO_NOT_TRACK", "1");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when CI=true", () => {
    vi.stubEnv("CI", "true");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when CI=1", () => {
    vi.stubEnv("CI", "1");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when GITHUB_ACTIONS=true", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when GITLAB_CI=true", () => {
    vi.stubEnv("GITLAB_CI", "true");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when CONTINUOUS_INTEGRATION=true", () => {
    vi.stubEnv("CONTINUOUS_INTEGRATION", "true");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when BUILD_NUMBER=1", () => {
    vi.stubEnv("BUILD_NUMBER", "1");
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });

  it("disables telemetry when fileConfig.enabled is false", () => {
    const config = resolveTelemetryConfig({ enabled: false });
    expect(config.enabled).toBe(false);
  });

  it("enables telemetry when no disable signals are set", () => {
    // Ensure none of the CI env vars are set
    for (const key of ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI",
                        "PAPERCLIP_TELEMETRY_DISABLED", "DO_NOT_TRACK"]) {
      vi.stubEnv(key, "");
    }
    const config = resolveTelemetryConfig({ enabled: true });
    expect(config.enabled).toBe(true);
  });

  it("includes custom endpoint from PAPERCLIP_TELEMETRY_ENDPOINT when enabled", () => {
    for (const key of ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI",
                        "PAPERCLIP_TELEMETRY_DISABLED", "DO_NOT_TRACK"]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("PAPERCLIP_TELEMETRY_ENDPOINT", "https://custom.telemetry.example.com");
    const config = resolveTelemetryConfig({ enabled: true });
    expect(config.enabled).toBe(true);
    expect((config as { endpoint?: string }).endpoint).toBe("https://custom.telemetry.example.com");
  });

  it("PAPERCLIP_TELEMETRY_DISABLED takes priority over DO_NOT_TRACK and CI", () => {
    vi.stubEnv("PAPERCLIP_TELEMETRY_DISABLED", "1");
    vi.stubEnv("DO_NOT_TRACK", ""); // not set
    const config = resolveTelemetryConfig();
    expect(config.enabled).toBe(false);
  });
});

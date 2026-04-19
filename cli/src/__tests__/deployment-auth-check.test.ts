import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { deploymentAuthCheck } from "../checks/deployment-auth-check.js";

function buildConfig(overrides?: {
  port?: number;
  host?: string;
  bind?: "loopback" | "lan" | "tailnet" | "custom";
  exposure?: "private" | "public";
  publicBaseUrl?: string;
  baseUrlMode?: "auto" | "explicit";
}): PaperclipConfig {
  return {
    server: {
      deploymentMode: "authenticated",
      exposure: overrides?.exposure ?? "private",
      bind: overrides?.bind ?? "tailnet",
      host: overrides?.host ?? "0.0.0.0",
      port: overrides?.port ?? 3210,
    },
    auth: {
      baseUrlMode: overrides?.baseUrlMode ?? "explicit",
      publicBaseUrl: overrides?.publicBaseUrl ?? "http://paperclip.example.com:3210",
      disableSignUp: false,
    },
  } as PaperclipConfig;
}

describe("deploymentAuthCheck", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
  });

  it("fails when an explicit shared URL port does not match server.port", () => {
    const result = deploymentAuthCheck(
      buildConfig({
        port: 3210,
        publicBaseUrl: "http://paperclip.example.com:3100",
      }),
    );

    expect(result).toMatchObject({
      status: "fail",
      message: "auth.publicBaseUrl port 3100 does not match server.port 3210",
    });
  });

  it("allows loopback explicit URLs to differ from server.port for local fallback flows", () => {
    const result = deploymentAuthCheck(
      buildConfig({
        host: "127.0.0.1",
        bind: "loopback",
        publicBaseUrl: "http://localhost:3100",
      }),
    );

    expect(result).toMatchObject({
      status: "pass",
    });
  });
});

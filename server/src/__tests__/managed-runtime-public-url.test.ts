import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

const missingConfigPath = path.join(os.tmpdir(), `paperclip-managed-runtime-config-${process.pid}.json`);

function useIsolatedConfigEnvironment() {
  vi.stubEnv("PAPERCLIP_CONFIG", missingConfigPath);
  vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("BETTER_AUTH_BASE_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_BASE_URL_MODE", "");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
  vi.stubEnv("PAPERCLIP_BIND", "loopback");
  vi.stubEnv("HOST", "127.0.0.1");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed runtime public URL config", () => {
  it("configures Better Auth from the managed runtime fallback", () => {
    useIsolatedConfigEnvironment();
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "https://worktree.tail29c1aa.ts.net");

    const config = loadConfig();

    expect(config.authPublicBaseUrl).toBe("https://worktree.tail29c1aa.ts.net");
    expect(config.authBaseUrlMode).toBe("explicit");
  });

  it("keeps explicit operator configuration ahead of the managed fallback", () => {
    useIsolatedConfigEnvironment();
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://operator.example.com");
    vi.stubEnv("PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL", "https://inferred.tail29c1aa.ts.net");

    const config = loadConfig();

    expect(config.authPublicBaseUrl).toBe("https://operator.example.com");
  });
});

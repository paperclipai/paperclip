import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

const missingConfigPath = path.join(os.tmpdir(), `paperclip-oauth-callback-origin-config-${process.pid}.json`);

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

describe("OAuth callback app origin config", () => {
  it("is unset by default", () => {
    useIsolatedConfigEnvironment();
    expect(loadConfig().oauthCallbackAppOrigin).toBeNull();
  });

  it("keeps the origin alone", () => {
    useIsolatedConfigEnvironment();
    vi.stubEnv("PAPERCLIP_OAUTH_CALLBACK_APP_ORIGIN", "https://paperclip.internal.example/board?x=1");
    expect(loadConfig().oauthCallbackAppOrigin).toBe("https://paperclip.internal.example");
  });

  it("allows plaintext only on loopback", () => {
    useIsolatedConfigEnvironment();
    vi.stubEnv("PAPERCLIP_OAUTH_CALLBACK_APP_ORIGIN", "http://127.0.0.1:3100");
    expect(loadConfig().oauthCallbackAppOrigin).toBe("http://127.0.0.1:3100");
  });

  // A value that is set but silently ignored looks exactly like the failure it
  // was meant to fix, so every rejection is loud.
  it.each([
    ["not-a-url", "is not a URL"],
    ["http://paperclip.internal.example", "must be an https origin"],
    ["https://user:pass@paperclip.internal.example", "must not carry credentials"],
  ])("rejects %s at startup", (value, reason) => {
    useIsolatedConfigEnvironment();
    vi.stubEnv("PAPERCLIP_OAUTH_CALLBACK_APP_ORIGIN", value);
    expect(() => loadConfig()).toThrow(reason);
  });
});

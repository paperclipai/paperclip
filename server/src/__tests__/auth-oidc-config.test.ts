import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

const oidcEnv = {
  PAPERCLIP_AUTH_OIDC_PROVIDER_ID: "idp",
  PAPERCLIP_AUTH_OIDC_DISPLAY_NAME: "Company sign-in",
  PAPERCLIP_AUTH_OIDC_DISCOVERY_URL: "https://idp.example.test/.well-known/openid-configuration",
  PAPERCLIP_AUTH_OIDC_CLIENT_ID: "paperclip",
};

function isolate(overrides: Record<string, string>) {
  vi.stubEnv("PAPERCLIP_CONFIG", path.join(os.tmpdir(), `paperclip-oidc-config-${process.pid}.json`));
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
  vi.stubEnv("PAPERCLIP_BIND", "loopback");
  vi.stubEnv("HOST", "127.0.0.1");
  for (const key of Object.keys(oidcEnv)) vi.stubEnv(key, "");
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenID Connect settings", () => {
  it("leaves the provider unset when no variable is set", () => {
    isolate({});
    expect(loadConfig().authOidc).toBeUndefined();
  });

  it("reads a complete set of variables", () => {
    isolate(oidcEnv);
    expect(loadConfig().authOidc).toMatchObject({ providerId: "idp", clientId: "paperclip" });
  });

  it("names the invalid fields instead of ignoring the settings", () => {
    isolate({ ...oidcEnv, PAPERCLIP_AUTH_OIDC_DISCOVERY_URL: "not-a-url" });
    expect(() => loadConfig()).toThrow("Invalid PAPERCLIP_AUTH_OIDC_* settings: discoveryUrl");
  });

  it("rejects a partial set of variables", () => {
    isolate({ PAPERCLIP_AUTH_OIDC_PROVIDER_ID: "idp" });
    expect(() => loadConfig()).toThrow(/displayName, discoveryUrl, clientId/);
  });
});

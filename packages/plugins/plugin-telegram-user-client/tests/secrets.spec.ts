import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import {
  deleteAccountSession,
  getAccountSession,
  newSessionSecretId,
  putAccountSession,
  resolveTelegramAppCredentials,
} from "../src/secrets.js";
import { containsSecretMaterial } from "../src/redaction.js";
import { MOCK_API_HASH, MOCK_SESSION } from "./support.js";

describe("secret handling", () => {
  it("resolves instance api credentials from secret-refs without logging them", async () => {
    const ctx = {
      config: {
        async get() {
          return {
            apiId: { type: "secret_ref", secretId: "api-id" },
            apiHash: { type: "secret_ref", secretId: "api-hash" },
          };
        },
      },
      secrets: {
        async resolve(ref: { secretId?: string }) {
          if (ref.secretId === "api-id") return "12345";
          if (ref.secretId === "api-hash") return MOCK_API_HASH;
          throw new Error("unknown secret");
        },
      },
    } as unknown as PluginContext;
    const credentials = await resolveTelegramAppCredentials(ctx, "company-1");
    expect(credentials).toEqual({ apiId: 12345, apiHash: MOCK_API_HASH });
  });

  it("persists a session secret in plugin state", async () => {
    const harness = createTestHarness({ manifest });
    const secretId = newSessionSecretId();
    await putAccountSession(harness.ctx, "company-1", secretId, MOCK_SESSION);
    expect(await getAccountSession(harness.ctx, "company-1", secretId)).toBe(MOCK_SESSION);
    expect(harness.getState({
      scopeKind: "company",
      scopeId: "company-1",
      namespace: "session-secrets",
      stateKey: secretId,
    })).toEqual({ session: MOCK_SESSION });
    await deleteAccountSession(harness.ctx, "company-1", secretId);
    expect(await getAccountSession(harness.ctx, "company-1", secretId)).toBeNull();
  });

  it("does not treat redacted logs as containing session material", () => {
    expect(containsSecretMaterial({ session: "[redacted]", message: "connected" }, [MOCK_SESSION])).toBe(false);
    expect(containsSecretMaterial({ session: MOCK_SESSION }, [MOCK_SESSION])).toBe(true);
  });

  it("declares api_id and api_hash as secret-ref config with no defaults", () => {
    const properties = manifest.instanceConfigSchema?.properties as Record<string, { format?: string; default?: unknown }>;
    expect(properties.apiId?.format).toBe("secret-ref");
    expect(properties.apiHash?.format).toBe("secret-ref");
    expect(properties.apiId?.default).toBeUndefined();
    expect(properties.apiHash?.default).toBeUndefined();
  });
});

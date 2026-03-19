import { beforeEach, describe, expect, it, vi } from "vitest";
import { companySecrets, companySecretVersions, pluginConfig } from "@paperclipai/db";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.js";

const getByIdMock = vi.fn();
const resolveVersionMock = vi.fn();

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getById: getByIdMock,
  }),
}));

vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: () => ({
    resolveVersion: resolveVersionMock,
  }),
}));

type DbRows = {
  configRows: Array<{ configJson: Record<string, unknown> }>;
  secretRows: Array<{
    id: string;
    provider: string;
    latestVersion: number;
    externalRef: string | null;
  }>;
  secretVersionRows: Array<{
    secretId: string;
    version: number;
    material: Record<string, unknown>;
  }>;
};

function createDbStub(rows: DbRows): any {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === pluginConfig) return Promise.resolve(rows.configRows);
              if (table === companySecrets) return Promise.resolve(rows.secretRows);
              if (table === companySecretVersions) return Promise.resolve(rows.secretVersionRows);
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
}

describe("createPluginSecretsHandler", () => {
  beforeEach(() => {
    getByIdMock.mockReset();
    resolveVersionMock.mockReset();
  });

  it("does not rate-limit repeated resolution of a config-allowed secret ref", async () => {
    const allowedRef = "11111111-1111-1111-1111-111111111111";
    const db = createDbStub({
      configRows: [{ configJson: { notionApiTokenRef: allowedRef } }],
      secretRows: [{
        id: allowedRef,
        provider: "local_encrypted",
        latestVersion: 1,
        externalRef: null,
      }],
      secretVersionRows: [{
        secretId: allowedRef,
        version: 1,
        material: { ciphertext: "abc" },
      }],
    });

    getByIdMock.mockResolvedValue({
      manifestJson: {
        instanceConfigSchema: {
          type: "object",
          properties: {
            notionApiTokenRef: { type: "string", format: "secret-ref" },
          },
        },
      },
    });
    resolveVersionMock.mockResolvedValue("notion-token");

    const handler = createPluginSecretsHandler({ db, pluginId: "marketing-plugin-id" });
    for (let i = 0; i < 60; i += 1) {
      await expect(handler.resolve({ secretRef: allowedRef })).resolves.toBe("notion-token");
    }
  });

  it("still rate-limits repeated disallowed secret enumeration attempts", async () => {
    const allowedRef = "11111111-1111-1111-1111-111111111111";
    const disallowedRef = "22222222-2222-2222-2222-222222222222";
    const db = createDbStub({
      configRows: [{ configJson: { notionApiTokenRef: allowedRef } }],
      secretRows: [{
        id: allowedRef,
        provider: "local_encrypted",
        latestVersion: 1,
        externalRef: null,
      }],
      secretVersionRows: [{
        secretId: allowedRef,
        version: 1,
        material: { ciphertext: "abc" },
      }],
    });

    getByIdMock.mockResolvedValue({
      manifestJson: {
        instanceConfigSchema: {
          type: "object",
          properties: {
            notionApiTokenRef: { type: "string", format: "secret-ref" },
          },
        },
      },
    });
    resolveVersionMock.mockResolvedValue("notion-token");

    const handler = createPluginSecretsHandler({ db, pluginId: "marketing-plugin-id" });
    for (let i = 0; i < 30; i += 1) {
      await expect(handler.resolve({ secretRef: disallowedRef })).rejects.toMatchObject({
        name: "SecretNotFoundError",
      });
    }

    await expect(handler.resolve({ secretRef: disallowedRef })).rejects.toMatchObject({
      name: "RateLimitExceededError",
      message: "Rate limit exceeded for secret resolution",
    });
  });
});

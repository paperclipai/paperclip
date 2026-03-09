import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createPluginSecretsHandler,
  type PluginSecretsService,
} from "../services/plugin-secrets-handler.js";

// ---------------------------------------------------------------------------
// Mock the secret provider registry
// ---------------------------------------------------------------------------

// Use vi.hoisted so the mock fn is available when vi.mock factory runs
const mockResolveVersion = vi.hoisted(() => vi.fn<
  [{ material: Record<string, unknown>; externalRef: string | null }],
  Promise<string>
>());

vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: vi.fn().mockReturnValue({
    id: "local_encrypted",
    descriptor: {
      id: "local_encrypted",
      label: "Local encrypted (default)",
      requiresExternalRef: false,
    },
    resolveVersion: mockResolveVersion,
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PLUGIN_ID = "acme.test-plugin";
const SECRET_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function makeSecretRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SECRET_UUID,
    companyId: "company-uuid-1",
    name: "MY_API_KEY",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 1,
    description: "Test secret",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeVersionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-uuid-1",
    secretId: SECRET_UUID,
    version: 1,
    material: {
      scheme: "local_encrypted_v1",
      iv: "base64iv==",
      tag: "base64tag==",
      ciphertext: "base64ct==",
    },
    valueSha256: "abc123",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

/**
 * Build a mock DB that chains:
 *   db.select().from(table).where(cond) → resolves with `rows`
 *
 * Supports two successive select calls with different results
 * (one for the secret lookup, one for the version lookup).
 */
function makeMockDb(
  secretRows: unknown[],
  versionRows: unknown[] = [],
) {
  // Each .select() call returns a fresh chain
  let selectCallCount = 0;
  const rowSets = [secretRows, versionRows];

  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          const idx = Math.min(selectCallCount, rowSets.length - 1);
          selectCallCount++;
          return Promise.resolve(rowSets[idx]);
        }),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPluginSecretsHandler", () => {
  let handler: PluginSecretsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveVersion.mockResolvedValue("resolved-secret-value");
  });

  // =========================================================================
  // Successful resolution
  // =========================================================================

  describe("successful resolution", () => {
    it("resolves a valid secret UUID through the provider", async () => {
      const db = makeMockDb([makeSecretRow()], [makeVersionRow()]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      const result = await handler.resolve({ secretRef: SECRET_UUID });

      expect(result).toBe("resolved-secret-value");
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(mockResolveVersion).toHaveBeenCalledWith({
        material: {
          scheme: "local_encrypted_v1",
          iv: "base64iv==",
          tag: "base64tag==",
          ciphertext: "base64ct==",
        },
        externalRef: null,
      });
    });

    it("passes externalRef to the provider when present", async () => {
      const db = makeMockDb(
        [makeSecretRow({ externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret" })],
        [makeVersionRow()],
      );
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await handler.resolve({ secretRef: SECRET_UUID });

      expect(mockResolveVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret",
        }),
      );
    });

    it("resolves with the correct version when latestVersion > 1", async () => {
      const db = makeMockDb(
        [makeSecretRow({ latestVersion: 3 })],
        [makeVersionRow({ version: 3 })],
      );
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      const result = await handler.resolve({ secretRef: SECRET_UUID });

      expect(result).toBe("resolved-secret-value");
    });

    it("trims whitespace from secretRef", async () => {
      const db = makeMockDb([makeSecretRow()], [makeVersionRow()]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      const result = await handler.resolve({ secretRef: `  ${SECRET_UUID}  ` });

      expect(result).toBe("resolved-secret-value");
    });
  });

  // =========================================================================
  // Validation errors
  // =========================================================================

  describe("validation errors", () => {
    it("throws InvalidSecretRefError for an empty string", async () => {
      const db = makeMockDb([]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await expect(handler.resolve({ secretRef: "" })).rejects.toThrow(
        "Invalid secret reference",
      );
      expect(db.select).not.toHaveBeenCalled();
    });

    it("throws InvalidSecretRefError for a whitespace-only string", async () => {
      const db = makeMockDb([]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await expect(handler.resolve({ secretRef: "   " })).rejects.toThrow(
        "Invalid secret reference",
      );
    });

    it("throws InvalidSecretRefError for a non-UUID string", async () => {
      const db = makeMockDb([]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await expect(handler.resolve({ secretRef: "not-a-uuid" })).rejects.toThrow(
        "Invalid secret reference",
      );
    });

    it("throws InvalidSecretRefError for a partial UUID", async () => {
      const db = makeMockDb([]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await expect(handler.resolve({ secretRef: "a1b2c3d4-e5f6" })).rejects.toThrow(
        "Invalid secret reference",
      );
    });
  });

  // =========================================================================
  // Secret not found
  // =========================================================================

  describe("secret not found", () => {
    it("throws SecretNotFoundError when the UUID does not match any secret", async () => {
      const db = makeMockDb([], []);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await expect(handler.resolve({ secretRef: SECRET_UUID })).rejects.toThrow(
        "Secret not found",
      );
      // Should have queried the DB once (for the secret) but NOT for the version
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(mockResolveVersion).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Version not found
  // =========================================================================

  describe("version not found", () => {
    it("throws SecretVersionNotFoundError when the secret exists but has no version row", async () => {
      const db = makeMockDb([makeSecretRow()], []);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await expect(handler.resolve({ secretRef: SECRET_UUID })).rejects.toThrow(
        "No version found for secret",
      );
      expect(db.select).toHaveBeenCalledTimes(2);
      expect(mockResolveVersion).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Provider errors
  // =========================================================================

  describe("provider errors", () => {
    it("propagates provider resolution errors", async () => {
      mockResolveVersion.mockRejectedValue(new Error("Provider decryption failed"));

      const db = makeMockDb([makeSecretRow()], [makeVersionRow()]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      await expect(handler.resolve({ secretRef: SECRET_UUID })).rejects.toThrow(
        "Provider decryption failed",
      );
    });
  });

  // =========================================================================
  // Security properties
  // =========================================================================

  describe("security properties", () => {
    it("error messages never contain secret values", async () => {
      const db = makeMockDb([], []);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      try {
        await handler.resolve({ secretRef: SECRET_UUID });
        expect.fail("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        // Message should contain the ref UUID but not any resolved value
        expect(msg).toContain(SECRET_UUID);
        expect(msg).not.toContain("resolved-secret-value");
      }
    });

    it("does not cache results between calls (each call goes through provider)", async () => {
      const db = makeMockDb([makeSecretRow()], [makeVersionRow()]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      // Call twice — the underlying mocks return fresh data each time
      mockResolveVersion
        .mockResolvedValueOnce("value-1")
        .mockResolvedValueOnce("value-2");

      // For the second call we need a fresh DB mock since our simple
      // mock only supports 2 select calls total.
      const db2 = makeMockDb([makeSecretRow()], [makeVersionRow()]);
      const handler2 = createPluginSecretsHandler({ db: db2 as never, pluginId: PLUGIN_ID });

      const result1 = await handler.resolve({ secretRef: SECRET_UUID });
      const result2 = await handler2.resolve({ secretRef: SECRET_UUID });

      expect(result1).toBe("value-1");
      expect(result2).toBe("value-2");
      expect(mockResolveVersion).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Integration with host-client-factory
  // =========================================================================

  describe("host-client-factory integration shape", () => {
    it("the resolve method accepts { secretRef } params matching WorkerToHostMethods", async () => {
      const db = makeMockDb([makeSecretRow()], [makeVersionRow()]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      // This matches the exact params shape from protocol.ts:
      // "secrets.resolve": [params: { secretRef: string }, result: string]
      const result = await handler.resolve({ secretRef: SECRET_UUID });
      expect(typeof result).toBe("string");
    });

    it("returns a string result matching WorkerToHostMethods result type", async () => {
      const db = makeMockDb([makeSecretRow()], [makeVersionRow()]);
      handler = createPluginSecretsHandler({ db: db as never, pluginId: PLUGIN_ID });

      const result = await handler.resolve({ secretRef: SECRET_UUID });
      // WorkerToHostMethods["secrets.resolve"][1] is `string`
      expect(typeof result).toBe("string");
      expect(result).toBe("resolved-secret-value");
    });
  });
});

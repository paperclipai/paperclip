import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPluginSecretsHandler, _resetRateLimiters } from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { logActivity } from "../services/activity-log.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { HttpError } from "../errors.js";

// Mock dependencies
vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockReturnValue(Promise.resolve()),
}));

vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: vi.fn(),
}));

describe("plugin-secrets-handler", () => {
  let db: any;
  const pluginId = "test-plugin-id";
  const companyId = "test-company-id";

  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimiters();
    
    // Simplest possible chained mock
    db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn(),
    };

    // Default registry mock
    vi.mocked(pluginRegistryService).mockReturnValue({
      getById: vi.fn().mockResolvedValue({ id: pluginId, companyId, manifestJson: {} }),
    } as any);
  });

  describe("write", () => {
    it("should validate the companyId via database lookup", async () => {
      const handler = createPluginSecretsHandler({ db, pluginId });
      db.then.mockImplementation(async (cb: any) => cb([])); // Settings check fails
      
      await expect(
        handler.write({ companyId, name: "TEST_SECRET", value: "secret123" })
      ).rejects.toThrow(`Plugin not enabled for company: ${companyId}`);
    });

    it("should securely create a new secret", async () => {
      const handler = createPluginSecretsHandler({ db, pluginId });
      db.then.mockImplementation(async (cb: any) => cb([{ enabled: true }]));

      const createMock = vi.fn().mockResolvedValue({ id: "new-secret-id" });
      vi.mocked(secretService).mockReturnValue({
        getByName: vi.fn().mockResolvedValue(null),
        create: createMock,
      } as any);

      const result = await handler.write({ 
        companyId, 
        name: "NEW_SECRET", 
        value: "secret123",
      });

      expect(result).toBe("new-secret-id");
    });
  });

  describe("resolve", () => {
    const secretRef = "550e8400-e29b-41d4-a716-446655440000";

    it("should allow a plugin to resolve a secret it created (fallback path)", async () => {
      const handler = createPluginSecretsHandler({ db, pluginId });
      
      // Sequence in resolve():
      // 1. db.select().from(companySecrets)
      // 2. checkRateLimit() -> no DB calls
      // 3. cachedAllowedRefs -> db.select().from(pluginConfig)
      // 4. cachedAllowedRefs -> registry.getById(pluginId)
      // 5. fallback Membership check -> db.select().from(pluginCompanySettings)
      // 6. db.select().from(companySecretVersions)
      
      db.then
        .mockImplementationOnce(async (cb: any) => cb([{ // 1. Global secret lookup
          id: secretRef, 
          companyId, 
          createdByUserId: `plugin:${pluginId}`,
          latestVersion: 1,
          provider: "local_encrypted"
        }]))
        .mockImplementationOnce(async (cb: any) => cb([])) // 3. cachedAllowedRefs (pluginConfig)
        .mockImplementationOnce(async (cb: any) => cb([{ enabled: true }])) // 5. Fallback membership
        .mockImplementationOnce(async (cb: any) => cb([{ material: {} }])); // 6. Version material

      vi.mocked(getSecretProvider).mockReturnValue({
        resolveVersion: vi.fn().mockResolvedValue("resolved-value"),
      } as any);

      const result = await handler.resolve({ secretRef });
      expect(result).toBe("resolved-value");
    });

    it("should deny resolution if the secret belongs to a different company (cross-tenant)", async () => {
      const handler = createPluginSecretsHandler({ db, pluginId });
      
      db.then
        .mockImplementationOnce(async (cb: any) => cb([{ // 1. Global secret lookup
          id: secretRef, 
          companyId: "OTHER_TENANT", 
          createdByUserId: `plugin:${pluginId}`, 
          latestVersion: 1 
        }]))
        .mockImplementationOnce(async (cb: any) => cb([])) // 3. Config
        .mockImplementationOnce(async (cb: any) => cb([])); // 5. Settings check (FAIL)

      await expect(
        handler.resolve({ secretRef })
      ).rejects.toThrow("Secret not found");
    });

    it("should deny resolution if the secret was created by a different plugin/user", async () => {
      const handler = createPluginSecretsHandler({ db, pluginId });
      
      db.then
        .mockImplementationOnce(async (cb: any) => cb([{ // 1. Global lookup - OTHER USER
          id: secretRef, 
          companyId, 
          createdByUserId: `user:someone-else`, 
          latestVersion: 1
        }]))
        .mockImplementationOnce(async (cb: any) => cb([])); // 3. Config

      await expect(
        handler.resolve({ secretRef })
      ).rejects.toThrow("Secret not found");
    });

    it("should deny resolution if the plugin is disabled for that company", async () => {
      const handler = createPluginSecretsHandler({ db, pluginId });
      
      db.then
        .mockImplementationOnce(async (cb: any) => cb([{ // 1. Global lookup
          id: secretRef, 
          companyId, 
          createdByUserId: `plugin:${pluginId}`, 
          latestVersion: 1 
        }]))
        .mockImplementationOnce(async (cb: any) => cb([])) // 3. Config
        .mockImplementationOnce(async (cb: any) => cb([])); // 5. Fallback membership (DISABLED)

      await expect(
        handler.resolve({ secretRef })
      ).rejects.toThrow("Secret not found");
    });
  });
});

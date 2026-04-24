import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPluginSecretsHandler, _resetRateLimiters } from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { logActivity } from "../services/activity-log.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { HttpError } from "../errors.js";
import { 
  pluginCompanySettings, 
  companySecrets, 
  companySecretVersions, 
  pluginConfig 
} from "@paperclipai/db";

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
    
    // Map-based mock using actual table objects as keys
    const tableResults = new Map<any, any[][]>();
    const state = { activeTable: null as any };

    const mockDb: any = {
      select: vi.fn(() => mockDb),
      from: vi.fn((table) => {
        state.activeTable = table;
        return mockDb;
      }),
      where: vi.fn(() => mockDb),
      then: vi.fn(async (cb) => {
        const queue = tableResults.get(state.activeTable) || [];
        const result = queue.shift() || [];
        return cb(result);
      }),
      _setTableResults: (table: any, results: any[][]) => {
        tableResults.set(table, results);
      }
    };

    db = mockDb;

    // Default registry mock
    vi.mocked(pluginRegistryService).mockReturnValue({
      getById: vi.fn().mockResolvedValue({ id: pluginId, companyId, manifestJson: {} }),
    } as any);
  });

  describe("createPluginSecretsHandler", () => {
    it("should initialize and return the service interface", () => {
      const handler = createPluginSecretsHandler({ db, pluginId });
      expect(handler.resolve).toBeTypeOf("function");
      expect(handler.write).toBeTypeOf("function");
    });
  });

  describe("write", () => {
    let handler: ReturnType<typeof createPluginSecretsHandler>;

    beforeEach(() => {
      handler = createPluginSecretsHandler({ db, pluginId });
      db._setTableResults(pluginCompanySettings, Array(100).fill([{ enabled: true }]));

      vi.mocked(secretService).mockReturnValue({
        getByName: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "new-secret-id" }),
        rotate: vi.fn().mockResolvedValue({ id: "rotated-secret-id" }),
      } as any);
    });

    it("should validate the companyId via database lookup", async () => {
      db._setTableResults(pluginCompanySettings, [[]]);
      await expect(
        handler.write({ companyId, name: "TEST_SECRET", value: "secret123" })
      ).rejects.toThrow(`Plugin not enabled for company: ${companyId}`);
    });

    it("should reject empty or whitespace-only names", async () => {
      await expect(handler.write({ companyId, name: "", value: "val" })).rejects.toThrow("Secret name must not be empty.");
      await expect(handler.write({ companyId, name: "   ", value: "val" })).rejects.toThrow("Secret name must not be empty.");
    });

    it("should reject names that are too long", async () => {
      const longName = "a".repeat(256);
      await expect(handler.write({ companyId, name: longName, value: "val" })).rejects.toThrow("Secret name must not exceed 255 characters.");
    });

    it("should reject invalid name characters", async () => {
      await expect(handler.write({ companyId, name: "INVALID NAME!", value: "val" })).rejects.toThrow("Secret name must only contain alphanumeric characters, underscores, and dashes.");
    });

    it("should reject empty or whitespace-only values", async () => {
      await expect(handler.write({ companyId, name: "VAL", value: "" })).rejects.toThrow("Secret value must not be empty.");
      await expect(handler.write({ companyId, name: "VAL", value: "   " })).rejects.toThrow("Secret value must not be empty.");
    });

    it("should reject oversized values (64 KiB)", async () => {
      const largeValue = "a".repeat(65537);
      await expect(handler.write({ companyId, name: "VAL", value: largeValue })).rejects.toThrow("Secret value must not exceed 64 KiB.");
    });

    it("should reject null bytes in values", async () => {
      await expect(handler.write({ companyId, name: "VAL", value: "v\0al" })).rejects.toThrow("Secret value must not contain null bytes.");
    });

    it("should reject reserved prefixes", async () => {
      await expect(handler.write({ companyId, name: "PAPERCLIP_VAL", value: "val" })).rejects.toThrow('Secret name "PAPERCLIP_VAL" is reserved for system use.');
      await expect(handler.write({ companyId, name: "BETTER_AUTH_VAL", value: "val" })).rejects.toThrow('Secret name "BETTER_AUTH_VAL" is reserved for system use.');
    });

    it("should enforce per-company rate limits", async () => {
      for (let i = 0; i < 10; i++) {
        await handler.write({ companyId, name: `S_${i}`, value: "val" });
      }
      await expect(
        handler.write({ companyId, name: "S_11", value: "val" })
      ).rejects.toThrow("Rate limit exceeded for secret creation");
    });

    it("should enforce global per-plugin rate limits", async () => {
      for (let c = 0; c < 5; c++) {
        const cId = `company_${c}`;
        db._setTableResults(pluginCompanySettings, Array(10).fill([{ enabled: true }]));
        for (let s = 0; s < 10; s++) {
          await handler.write({ companyId: cId, name: `S_${s}`, value: "val" });
        }
      }
      db._setTableResults(pluginCompanySettings, [[{ enabled: true }]]);
      await expect(
        handler.write({ companyId: "company_6", name: "S_X", value: "val" })
      ).rejects.toThrow("Global rate limit exceeded for secret creation");
    });

    it("should allow a plugin to rotate its own secret", async () => {
      const rotateMock = vi.fn().mockResolvedValue({ id: "rotated-id" });
      vi.mocked(secretService).mockReturnValue({
        getByName: vi.fn().mockResolvedValue({ id: "existing-id", createdByUserId: `plugin:${pluginId}` }),
        rotate: rotateMock,
      } as any);

      const result = await handler.write({ companyId, name: "OWNED", value: "new-val" });
      expect(result).toBe("rotated-id");
      expect(rotateMock).toHaveBeenCalled();
    });

    it("should handle TOCTOU race via HttpError(409)", async () => {
      const createMock = vi.fn().mockRejectedValue(new HttpError(409, "Conflict"));
      const rotateMock = vi.fn().mockResolvedValue({ id: "rotated-raced-id" });
      const getByNameMock = vi.fn()
        .mockResolvedValueOnce(null) // first call: no existing secret → triggers create()
        .mockResolvedValueOnce({ id: "raced-id", createdByUserId: `plugin:${pluginId}` }); // second call: catch block recovery

      vi.mocked(secretService).mockReturnValue({
        getByName: getByNameMock,
        create: createMock,
        rotate: rotateMock,
      } as any);

      const result = await handler.write({ companyId, name: "RACED", value: "raced-val" });
      
      expect(result).toBe("rotated-raced-id");
      expect(createMock).toHaveBeenCalledOnce();
      expect(getByNameMock).toHaveBeenCalledTimes(2);
      expect(rotateMock).toHaveBeenCalledOnce();
    });
  });

  describe("resolve", () => {
    let handler: ReturnType<typeof createPluginSecretsHandler>;
    const secretRef = "550e8400-e29b-41d4-a716-446655440000";

    beforeEach(() => {
      handler = createPluginSecretsHandler({ db, pluginId });
      vi.mocked(getSecretProvider).mockReturnValue({
        resolveVersion: vi.fn().mockResolvedValue("resolved-value"),
      } as any);
    });

    it("should allow a plugin to resolve a secret it created (fallback path)", async () => {
      db._setTableResults(companySecrets, [
        [{ id: secretRef, companyId, createdByUserId: `plugin:${pluginId}`, latestVersion: 1, provider: "local_encrypted" }]
      ]);
      db._setTableResults(pluginConfig, [[]]);
      db._setTableResults(pluginCompanySettings, [[{ enabled: true }]]);
      db._setTableResults(companySecretVersions, [[{ material: {} }]]);

      const result = await handler.resolve({ secretRef });
      expect(result).toBe("resolved-value");
    });

    it("should enforce global resolve rate limits", async () => {
      for (let i = 0; i < 100; i++) {
        const uniqueRef = `550e8400-e29b-41d4-a716-${i.toString().padStart(12, '0')}`;
        const uniqueCompanyId = `company-${i}`;
        // Mock DB for each attempt
        db._setTableResults(companySecrets, [
          [{ id: uniqueRef, companyId: uniqueCompanyId, createdByUserId: `plugin:${pluginId}`, latestVersion: 1, provider: "local_encrypted" }]
        ]);
        db._setTableResults(pluginConfig, [[]]);
        db._setTableResults(pluginCompanySettings, [[{ enabled: true }]]);
        db._setTableResults(companySecretVersions, [[{ material: {} }]]);
        
        await handler.resolve({ secretRef: uniqueRef });
      }
      
      await expect(
        handler.resolve({ secretRef })
      ).rejects.toThrow("Rate limit exceeded for secret resolution");
    });

    it("should deny resolution if the secret belongs to a different company (cross-tenant)", async () => {
      db._setTableResults(companySecrets, [
        [{ id: secretRef, companyId: "OTHER_TENANT", createdByUserId: `plugin:${pluginId}`, latestVersion: 1 }]
      ]);
      db._setTableResults(pluginConfig, [[]]);
      db._setTableResults(pluginCompanySettings, [[]]);

      await expect(handler.resolve({ secretRef })).rejects.toThrow("Secret not found");
    });
  });
});

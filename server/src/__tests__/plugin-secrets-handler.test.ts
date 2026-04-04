import { describe, expect, it, vi, beforeEach } from "vitest";
import { createPluginSecretsHandler, _resetRateLimiters } from "../services/plugin-secrets-handler.js";
import { secretService } from "../services/secrets.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { logActivity } from "../services/activity-log.js";
import { HttpError } from "../errors.js";

// Mock dependencies
vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

describe("plugin-secrets-handler", () => {
  let db: any;
  const pluginId = "test-plugin-id";
  const companyId = "test-company-id";

  beforeEach(() => {
    vi.clearAllMocks();
    _resetRateLimiters();
    db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation(async (cb) => cb([])),
    };
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
      
      // Default to returning a valid pluginCompanySettings record
      db.then.mockImplementation(async (cb: any) => cb([{ 
        pluginId, 
        companyId, 
        enabled: true 
      }]));

      // Default mock for secretService
      vi.mocked(secretService).mockReturnValue({
        getByName: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "new-secret-id" }),
        rotate: vi.fn().mockResolvedValue({ id: "rotated-secret-id" }),
      } as any);
    });

    it("should validate the companyId via database lookup", async () => {
      db.then.mockImplementation(async (cb: any) => cb([])); // Simulate plugin NOT enabled
      
      await expect(
        handler.write({ companyId, name: "TEST_SECRET", value: "secret123" })
      ).rejects.toThrow(`Plugin not enabled for company: ${companyId}`);
    });

    it("should reject empty names", async () => {
      await expect(
        handler.write({ companyId, name: "", value: "secret123" })
      ).rejects.toThrow("Secret name must not be empty.");
    });

    it("should reject names that are too long", async () => {
      const longName = "a".repeat(256);
      await expect(
        handler.write({ companyId, name: longName, value: "secret123" })
      ).rejects.toThrow("Secret name must not exceed 255 characters.");
    });

    it("should reject invalid name characters", async () => {
      await expect(
        handler.write({ companyId, name: "INVALID NAME!", value: "secret123" })
      ).rejects.toThrow("Secret name must only contain alphanumeric characters, underscores, and dashes.");
    });

    it("should reject empty values", async () => {
      await expect(
        handler.write({ companyId, name: "VALID_NAME", value: "" })
      ).rejects.toThrow("Secret value must not be empty.");
    });

    it("should reject oversized values (64 KiB)", async () => {
      const largeValue = "a".repeat(65537);
      await expect(
        handler.write({ companyId, name: "VALID_NAME", value: largeValue })
      ).rejects.toThrow("Secret value must not exceed 64 KiB.");
    });

    it("should reject null bytes in values", async () => {
      await expect(
        handler.write({ companyId, name: "VALID_NAME", value: "value\0withnull" })
      ).rejects.toThrow("Secret value must not contain null bytes.");
    });

    it("should reject reserved prefixes", async () => {
      await expect(
        handler.write({ companyId, name: "PAPERCLIP_SECRET", value: "secret123" })
      ).rejects.toThrow('Secret name "PAPERCLIP_SECRET" is reserved for system use.');
      
      await expect(
        handler.write({ companyId, name: "BETTER_AUTH_SECRET", value: "secret123" })
      ).rejects.toThrow('Secret name "BETTER_AUTH_SECRET" is reserved for system use.');
    });

    it("should securely create a new secret and audit log it", async () => {
      const createMock = vi.fn().mockResolvedValue({ id: "new-secret-id" });
      vi.mocked(secretService).mockReturnValue({
        getByName: vi.fn().mockResolvedValue(null),
        create: createMock,
      } as any);

      const result = await handler.write({ 
        companyId, 
        name: "NEW_SECRET", 
        value: "secret123",
        description: "Test desc"
      });

      expect(result).toBe("new-secret-id");
      expect(createMock).toHaveBeenCalledWith(
        companyId,
        {
          name: "NEW_SECRET",
          provider: "local_encrypted",
          value: "secret123",
          description: "Test desc",
        },
        { userId: `plugin:${pluginId}`, agentId: null }
      );
      
      expect(logActivity).toHaveBeenCalledWith(db, expect.objectContaining({
        action: "secret.created",
        entityId: "new-secret-id"
      }));
    });

    it("should allow a plugin to rotate its own secret", async () => {
      const rotateMock = vi.fn().mockResolvedValue({ id: "rotated-secret-id" });
      vi.mocked(secretService).mockReturnValue({
        getByName: vi.fn().mockResolvedValue({ 
          id: "existing-id", 
          createdByUserId: `plugin:${pluginId}` 
        }),
        rotate: rotateMock,
      } as any);

      const result = await handler.write({ 
        companyId, 
        name: "OWNED_SECRET", 
        value: "new-secret123",
        description: "Updated desc"
      });

      expect(result).toBe("rotated-secret-id");
      expect(rotateMock).toHaveBeenCalledWith(
        "existing-id",
        { value: "new-secret123", description: "Updated desc" },
        { userId: `plugin:${pluginId}`, agentId: null }
      );
      
      expect(logActivity).toHaveBeenCalledWith(db, expect.objectContaining({
        action: "secret.rotated",
        entityId: "rotated-secret-id"
      }));
    });

    it("should block a plugin from rotating a secret it did not create", async () => {
      vi.mocked(secretService).mockReturnValue({
        getByName: vi.fn().mockResolvedValue({ 
          id: "existing-id", 
          createdByUserId: `human-user-id` // Not the plugin
        }),
      } as any);

      await expect(
        handler.write({ companyId, name: "HUMAN_SECRET", value: "new-secret123" })
      ).rejects.toThrow('Collision: A secret named "HUMAN_SECRET" already exists and was not created by this plugin.');
    });

    it("should handle TOCTOU race conditions via HttpError(409) fallback", async () => {
      const rotateMock = vi.fn().mockResolvedValue({ id: "raced-rotated-secret-id" });
      
      // Simulate create failing with HttpError 409
      const createMock = vi.fn().mockRejectedValue(new HttpError(409, "Conflict"));
      
      // Simulate getByName returning the secret we just raced to create
      const getByNameMock = vi.fn().mockResolvedValue({ 
        id: "raced-id", 
        createdByUserId: `plugin:${pluginId}` 
      });

      vi.mocked(secretService).mockReturnValue({
        getByName: getByNameMock,
        create: createMock,
        rotate: rotateMock,
      } as any);

      const result = await handler.write({ 
        companyId, 
        name: "RACED_SECRET", 
        value: "raced-secret123",
        description: "Raced desc"
      });

      expect(result).toBe("raced-rotated-secret-id");
      expect(rotateMock).toHaveBeenCalledWith(
        "raced-id",
        { value: "raced-secret123", description: "Raced desc" },
        { userId: `plugin:${pluginId}`, agentId: null }
      );
    });
  });
});

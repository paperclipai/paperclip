import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { companyStandingService } from "./company-standing.js";
import { badRequest } from "../errors.js";

// Mock the database and badRequest
vi.mock("../errors.js", () => ({
  badRequest: (message: string) => new Error(message),
}));

describe("companyStandingService.setStanding", () => {
  let mockDb: Db;
  let service: ReturnType<typeof companyStandingService>;

  beforeEach(() => {
    mockDb = {
      insert: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      set: vi.fn().mockResolvedValue(undefined),
    } as any;

    service = companyStandingService(mockDb);
  });

  describe("actionUrl validation", () => {
    it("rejects javascript: URLs", async () => {
      const input = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
        actionUrl: "javascript:alert('xss')",
      };

      await expect(service.setStanding("plugin-1", "company-1", input)).rejects.toThrow(
        /Invalid actionUrl scheme/,
      );
    });

    it("rejects data: URLs", async () => {
      const input = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
        actionUrl: "data:text/html,<script>alert('xss')</script>",
      };

      await expect(service.setStanding("plugin-1", "company-1", input)).rejects.toThrow(
        /Invalid actionUrl scheme/,
      );
    });

    it("accepts https: URLs", async () => {
      const input = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
        actionUrl: "https://example.com/billing",
      };

      await expect(service.setStanding("plugin-1", "company-1", input)).resolves.not.toThrow();
    });

    it("accepts http: URLs", async () => {
      const input = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
        actionUrl: "http://example.com/billing",
      };

      await expect(service.setStanding("plugin-1", "company-1", input)).resolves.not.toThrow();
    });

    it("accepts app-relative paths starting with /", async () => {
      const input = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
        actionUrl: "/company/settings/billing",
      };

      await expect(service.setStanding("plugin-1", "company-1", input)).resolves.not.toThrow();
    });

    it("allows absent/undefined actionUrl", async () => {
      const input1 = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
      };

      const input2 = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
        actionUrl: undefined,
      };

      await expect(service.setStanding("plugin-1", "company-1", input1)).resolves.not.toThrow();
      await expect(service.setStanding("plugin-1", "company-1", input2)).resolves.not.toThrow();
    });

    it("allows empty string actionUrl (treated as absent)", async () => {
      const input = {
        status: "blocked" as const,
        reason: "Test reason",
        message: "Test message",
        actionUrl: "   ",
      };

      await expect(service.setStanding("plugin-1", "company-1", input)).resolves.not.toThrow();
    });
  });
});

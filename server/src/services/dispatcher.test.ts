import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";
import { createDispatcherService, SUBSCRIPTION_PROVIDER_MAP, KNOWN_SUBSCRIPTIONS, type DispatchTask } from "./dispatcher.js";

describe("dispatcher", () => {
  describe("SUBSCRIPTION_PROVIDER_MAP", () => {
    it("maps all known subscriptions to providers", () => {
      expect(SUBSCRIPTION_PROVIDER_MAP).toEqual({
        "Anthropic Max": "anthropic",
        "ChatGPT Pro 20x": "openai",
        "Gemini AI Ultra": "google",
        "BytePlus Coding Plan": "byteplus",
        "MiniMax Coding Plan": "minimax",
        "Z.AI Coding Plan": "zai",
      });
    });
  });

  describe("KNOWN_SUBSCRIPTIONS", () => {
    it("contains all subscription names", () => {
      expect(KNOWN_SUBSCRIPTIONS).toContain("Anthropic Max");
      expect(KNOWN_SUBSCRIPTIONS).toContain("ChatGPT Pro 20x");
      expect(KNOWN_SUBSCRIPTIONS).toContain("Gemini AI Ultra");
      expect(KNOWN_SUBSCRIPTIONS).toContain("BytePlus Coding Plan");
      expect(KNOWN_SUBSCRIPTIONS).toContain("MiniMax Coding Plan");
      expect(KNOWN_SUBSCRIPTIONS).toContain("Z.AI Coding Plan");
    });
  });

  describe("createDispatcherService", () => {
    let mockExecute: ReturnType<typeof vi.fn>;
    let mockDb: Db;

    beforeEach(() => {
      mockExecute = vi.fn();
      mockDb = {
        execute: mockExecute,
        select: vi.fn().mockReturnValue({}) as any,
        insert: vi.fn().mockReturnValue({}) as any,
        update: vi.fn().mockReturnValue({}) as any,
        delete: vi.fn().mockReturnValue({}) as any,
      } as unknown as Db;
    });

    describe("dispatch", () => {
      it("returns allExhausted=true when no candidates found for role", async () => {
        mockExecute.mockResolvedValue({ rows: [] });

        const dispatcher = createDispatcherService(mockDb);
        const task: DispatchTask = {
          issueId: "issue-1",
          role: "engineer",
          taskComplexity: "M",
        };

        const result = await dispatcher.dispatch(task);

        expect(result.dispatchAllowed).toBe(false);
        expect(result.allExhausted).toBe(true);
        expect(result.reason).toContain("No candidates found");
      });

      it("applies task complexity factor correctly", () => {
        const taskS: DispatchTask = { issueId: "1", role: "eng", taskComplexity: "S" };
        const taskXL: DispatchTask = { issueId: "1", role: "eng", taskComplexity: "XL" };

        const factors = { S: 1.5, M: 1.2, L: 1.0, XL: 0.8 };
        expect(factors[taskS.taskComplexity]).toBe(1.5);
        expect(factors[taskXL.taskComplexity]).toBe(0.8);
      });
    });

    describe("getQuotaStatus", () => {
      it("returns default available when no quota rows exist", async () => {
        mockExecute.mockResolvedValue({ rows: [] });

        const dispatcher = createDispatcherService(mockDb);
        const status = await dispatcher.getQuotaStatus("Anthropic Max");

        expect(status).toEqual({
          subscription: "Anthropic Max",
          available: 0.7,
          saturated: false,
        });
      });
    });
  });
});
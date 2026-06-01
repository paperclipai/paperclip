import { describe, it, expect } from "vitest";
import {
  extractSessionId,
  extractModel,
  extractUsage,
  extractCost,
  extractBobMetadata,
  calculateCostFromUsage,
} from "./metadata-extraction.js";

describe("Bob Shell Metadata Extraction", () => {
  describe("extractSessionId", () => {
    it("should extract session ID from standard format", () => {
      const stdout = "Session ID: abc123def456\nOther output...";
      expect(extractSessionId(stdout)).toBe("abc123def456");
    });

    it("should extract session ID from saved session format", () => {
      const stdout = "Task completed. Saved session: xyz789\n";
      expect(extractSessionId(stdout)).toBe("xyz789");
    });

    it("should extract session ID from resuming format", () => {
      const stdout = "Resuming session: session-12345\n";
      expect(extractSessionId(stdout)).toBe("session-12345");
    });

    it("should return null if no session ID found", () => {
      const stdout = "No session information here";
      expect(extractSessionId(stdout)).toBe(null);
    });
  });

  describe("extractModel", () => {
    it("should extract model from standard format", () => {
      const stdout = "Model: claude-3-5-sonnet-20241022\nProcessing...";
      expect(extractModel(stdout)).toBe("claude-3-5-sonnet-20241022");
    });

    it("should extract model from using model format", () => {
      const stdout = "Using model: gpt-4-turbo\n";
      expect(extractModel(stdout)).toBe("gpt-4-turbo");
    });

    it("should extract model from model_id format", () => {
      const stdout = "Configuration: model_id: claude-opus-3\n";
      expect(extractModel(stdout)).toBe("claude-opus-3");
    });

    it("should return null if no model found", () => {
      const stdout = "No model information";
      expect(extractModel(stdout)).toBe(null);
    });
  });

  describe("extractUsage", () => {
    it("should extract usage from JSON format", () => {
      const stdout = 'Input tokens: 1500\nOutput tokens: 500\nCached tokens: 200';
      const usage = extractUsage(stdout);
      
      expect(usage).not.toBe(null);
      expect(usage?.inputTokens).toBe(1500);
      expect(usage?.outputTokens).toBe(500);
      expect(usage?.cachedInputTokens).toBe(200);
    });

    it("should extract usage from structured text format", () => {
      const stdout = "Input tokens: 1000\nOutput tokens: 300\nCached tokens: 100";
      const usage = extractUsage(stdout);
      
      expect(usage).not.toBe(null);
      expect(usage?.inputTokens).toBe(1000);
      expect(usage?.outputTokens).toBe(300);
      expect(usage?.cachedInputTokens).toBe(100);
    });

    it("should extract usage from combined format", () => {
      const stdout = "Tokens: 1500 (1000 input, 500 output)";
      const usage = extractUsage(stdout);
      
      expect(usage).not.toBe(null);
      expect(usage?.inputTokens).toBe(1000);
      expect(usage?.outputTokens).toBe(500);
    });

    it("should return null if no usage found", () => {
      const stdout = "No token information";
      expect(extractUsage(stdout)).toBe(null);
    });

    it("should handle partial usage information", () => {
      const stdout = "Input tokens: 500";
      const usage = extractUsage(stdout);
      
      expect(usage).not.toBe(null);
      expect(usage?.inputTokens).toBe(500);
      expect(usage?.outputTokens).toBe(0);
      expect(usage?.cachedInputTokens).toBe(0);
    });
  });

  describe("extractCost", () => {
    it("should extract cost from standard format", () => {
      const stdout = "Cost: $0.05\nTask completed";
      expect(extractCost(stdout)).toBe(0.05);
    });

    it("should extract cost from total cost format", () => {
      const stdout = "Total cost: 0.15 USD";
      expect(extractCost(stdout)).toBe(0.15);
    });

    it("should extract cost from cost_usd format", () => {
      const stdout = "Metadata: cost_usd: 0.025";
      expect(extractCost(stdout)).toBe(0.025);
    });

    it("should extract cost without dollar sign", () => {
      const stdout = "Cost: 0.10";
      expect(extractCost(stdout)).toBe(0.10);
    });

    it("should return null if no cost found", () => {
      const stdout = "No cost information";
      expect(extractCost(stdout)).toBe(null);
    });

    it("should return null for invalid cost", () => {
      const stdout = "Cost: invalid";
      expect(extractCost(stdout)).toBe(null);
    });
  });

  describe("extractBobMetadata", () => {
    it("should extract all metadata from comprehensive output", () => {
      const stdout = `
Session ID: test-session-123
Model: claude-3-5-sonnet-20241022
Input tokens: 1500
Output tokens: 500
Cached tokens: 200
Cost: $0.08
Task completed successfully
      `;

      const metadata = extractBobMetadata(stdout);
      
      expect(metadata.sessionId).toBe("test-session-123");
      expect(metadata.model).toBe("claude-3-5-sonnet-20241022");
      expect(metadata.usage).not.toBe(null);
      expect(metadata.usage?.inputTokens).toBe(1500);
      expect(metadata.usage?.outputTokens).toBe(500);
      expect(metadata.usage?.cachedInputTokens).toBe(200);
      expect(metadata.costUsd).toBe(0.08);
    });

    it("should handle partial metadata", () => {
      const stdout = "Model: gpt-4\nInput tokens: 1000";
      const metadata = extractBobMetadata(stdout);
      
      expect(metadata.sessionId).toBe(null);
      expect(metadata.model).toBe("gpt-4");
      expect(metadata.usage).not.toBe(null);
      expect(metadata.costUsd).toBe(null);
    });

    it("should handle no metadata", () => {
      const stdout = "Just some output text";
      const metadata = extractBobMetadata(stdout);
      
      expect(metadata.sessionId).toBe(null);
      expect(metadata.model).toBe(null);
      expect(metadata.usage).toBe(null);
      expect(metadata.costUsd).toBe(null);
    });
  });

  describe("calculateCostFromUsage", () => {
    it("should calculate cost for Claude 3.5 Sonnet", () => {
      const usage = {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 500_000,
      };
      const cost = calculateCostFromUsage(usage, "claude-3-5-sonnet-20241022");
      
      expect(cost).not.toBe(null);
      expect(cost).toBeCloseTo(10.5, 1); // 3.0 + 7.5
    });

    it("should calculate cost for GPT-4", () => {
      const usage = {
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 2_000_000,
      };
      const cost = calculateCostFromUsage(usage, "gpt-4");
      
      expect(cost).not.toBe(null);
      expect(cost).toBeCloseTo(150.0, 1); // 30.0 + 120.0
    });

    it("should apply discount for cached tokens", () => {
      const usage = {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      };
      const cost = calculateCostFromUsage(usage, "claude-3-5-sonnet");
      
      expect(cost).not.toBe(null);
      // 3.0 (input) + 0.3 (cached at 10%) = 3.3
      expect(cost).toBeCloseTo(3.3, 1);
    });

    it("should return null for unknown model", () => {
      const usage = {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 500,
      };
      const cost = calculateCostFromUsage(usage, "unknown-model");
      
      expect(cost).toBe(null);
    });

    it("should return null for null model", () => {
      const usage = {
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 500,
      };
      const cost = calculateCostFromUsage(usage, null);
      
      expect(cost).toBe(null);
    });
  });
});

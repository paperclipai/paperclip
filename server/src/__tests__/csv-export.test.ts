import { describe, expect, it } from "vitest";
import { arrayToCSV, escapeCSVField } from "../csv-export.js";

describe("CSV Export Utilities", () => {
  describe("escapeCSVField", () => {
    it("returns empty string for null/undefined", () => {
      expect(escapeCSVField(null)).toBe("");
      expect(escapeCSVField(undefined)).toBe("");
    });

    it("returns plain values unchanged", () => {
      expect(escapeCSVField("simple")).toBe("simple");
      expect(escapeCSVField("123")).toBe("123");
      expect(escapeCSVField(123)).toBe("123");
    });

    it("wraps and escapes fields with commas", () => {
      expect(escapeCSVField("test,value")).toBe('"test,value"');
    });

    it("wraps and escapes fields with quotes", () => {
      expect(escapeCSVField('test"value')).toBe('"test""value"');
    });

    it("wraps and escapes fields with newlines", () => {
      expect(escapeCSVField("test\nvalue")).toBe('"test\nvalue"');
    });

    it("handles combined special characters", () => {
      expect(escapeCSVField('test,"value"\nnew')).toBe('"test,""value""\nnew"');
    });
  });

  describe("arrayToCSV", () => {
    it("converts simple array to CSV", () => {
      const data = [
        { id: "1", name: "Alice", age: 30 },
        { id: "2", name: "Bob", age: 25 },
      ];
      const csv = arrayToCSV(data);
      expect(csv).toBe('id,name,age\n1,Alice,30\n2,Bob,25\n');
    });

    it("returns header-only for empty array", () => {
      const csv = arrayToCSV([]);
      expect(csv).toBe("");
    });

    it("escapes fields with special characters", () => {
      const data = [
        { name: "Test,User", email: 'user@test.com' },
      ];
      const csv = arrayToCSV(data);
      expect(csv).toBe('name,email\n"Test,User",user@test.com\n');
    });

    it("handles null/undefined values", () => {
      const data = [
        { id: "1", value: null, status: undefined },
      ];
      const csv = arrayToCSV(data);
      expect(csv).toBe('id,value,status\n1,,\n');
    });

    it("uses custom headers when provided", () => {
      const data = [
        { a: "1", b: "2", c: "3" },
      ];
      const csv = arrayToCSV(data, ["a", "c"]);
      expect(csv).toBe('a,c\n1,3\n');
    });

    it("handles cost export data format", () => {
      const data = [
        {
          id: "uuid-1",
          agentName: "Test Agent",
          provider: "anthropic",
          biller: "anthropic",
          billingType: "subscription_included",
          model: "claude-sonnet-4-5",
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 200,
          costCents: 0,
          occurredAt: "2026-04-16T14:30:00Z",
        },
      ];
      const csv = arrayToCSV(data);
      expect(csv).toContain("id,agentName,provider,biller,billingType");
      expect(csv).toContain("uuid-1,Test Agent,anthropic");
      expect(csv).toContain("1000,500,200,0");
    });

    it("handles finance export data format", () => {
      const data = [
        {
          id: "uuid-1",
          eventKind: "credit_purchase",
          direction: "debit",
          biller: "openrouter",
          amountCents: 10000,
          currency: "USD",
          estimated: false,
        },
      ];
      const csv = arrayToCSV(data);
      expect(csv).toContain("id,eventKind,direction,biller");
      expect(csv).toContain("credit_purchase,debit,openrouter,10000,USD,false");
    });
  });
});

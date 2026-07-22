import { describe, expect, it } from "vitest";
import { formatCents, formatModelDisplayName, formatTokenBreakdown, providerDisplayName } from "./utils";

describe("providerDisplayName", () => {
  it("normalizes DeepSeek for cost views and drilldowns", () => {
    expect(providerDisplayName("deepseek")).toBe("DeepSeek");
    expect(providerDisplayName("DeepSeek")).toBe("DeepSeek");
  });
});

describe("formatCents", () => {
  it("keeps sub-cent values visible when they are under one cent", () => {
    expect(formatCents(0.8729)).toBe("$0.008729");
  });

  it("still renders normal cents values with two decimals", () => {
    expect(formatCents(12.34)).toBe("$0.12");
  });
});

describe("formatTokenBreakdown", () => {
  it("shows cached input tokens separately when present", () => {
    expect(formatTokenBreakdown(100, 25, 50)).toBe("in 125 (cached 25) · out 50");
  });

  it("omits the cached clause when there is no cached input", () => {
    expect(formatTokenBreakdown(100, 0, 50)).toBe("in 100 · out 50");
  });
});

describe("formatModelDisplayName", () => {
  it("normalizes DeepSeek model ids to compact lane labels", () => {
    expect(formatModelDisplayName("deepseek-v4-flash")).toBe("Flash");
    expect(formatModelDisplayName("deepseek-chat")).toBe("Flash");
    expect(formatModelDisplayName("deepseek-reasoner")).toBe("Flash");
    expect(formatModelDisplayName("deepseek-v4-pro")).toBe("Pro");
  });

  it("passes through unrelated model ids", () => {
    expect(formatModelDisplayName("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
});

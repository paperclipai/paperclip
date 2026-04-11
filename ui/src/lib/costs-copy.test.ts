import { describe, expect, it } from "vitest";

import {
  formatBudgetPolicyLimitSubtitle,
  formatBudgetPolicyPausedDescription,
  formatBudgetPolicyStatusLabel,
  formatBudgetPolicyWindowLabel,
  getCostsCopy,
} from "./costs-copy";

describe("costs-copy budget policy labels", () => {
  it("returns Chinese budget card copy", () => {
    const copy = getCostsCopy("zh-CN");

    expect(copy.budgetCardBudgetUsdLabel).toBe("预算（USD）");
    expect(copy.budgetCardRemaining).toBe("剩余");
  });

  it("formats Chinese budget policy strings", () => {
    expect(formatBudgetPolicyWindowLabel("lifetime", "zh-CN")).toBe("生命周期预算");
    expect(formatBudgetPolicyLimitSubtitle(10_000, 42, "zh-CN")).toBe("已使用上限的 42%");
    expect(formatBudgetPolicyStatusLabel("warning", false, "zh-CN")).toBe("警告");
    expect(formatBudgetPolicyPausedDescription("project", "zh-CN")).toContain("项目");
  });
});

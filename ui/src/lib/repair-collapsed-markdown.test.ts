import { describe, expect, it } from "vitest";
import { isCollapsedMarkdown, repairCollapsedMarkdown } from "./repair-collapsed-markdown";

describe("repairCollapsedMarkdown", () => {
  it("restores headings, blockquotes, and bullet lists from collapsed issue documents", () => {
    const input = "# 研究任务 Brief：面向Agent的软件设计趋势与数据资产化商业模式  > 状态：draft > 版本：0.1.0 > owner：Research & Knowledge Lead  ## 1. 基本信息  - 任务名称：面向Agent的软件设计趋势与数据资产化商业模式研究 - 发起时间：2026-04-05 - 发起人：CEO";

    expect(isCollapsedMarkdown(input)).toBe(true);
    expect(repairCollapsedMarkdown(input)).toBe([
      "# 研究任务 Brief：面向Agent的软件设计趋势与数据资产化商业模式",
      "> 状态：draft",
      "> 版本：0.1.0",
      "> owner：Research & Knowledge Lead",
      "",
      "## 1. 基本信息",
      "- 任务名称：面向Agent的软件设计趋势与数据资产化商业模式研究",
      "- 发起时间：2026-04-05",
      "- 发起人：CEO",
    ].join("\n"));
  });

  it("restores numbered lists and thematic separators from collapsed synthesis documents", () => {
    const input = "# 研究综合结论：面向Agent的软件设计趋势与数据资产化商业模式 > 状态：完成 > 版本：1.0.0 > owner：Research & Knowledge Lead  ## 2. 核心事实 ### 行业发展现状事实 1. **标准层面**：MCP已经成为事实标准 2. **产品层面**：主流平台都已支持Skill封装 ---  ## 3. 模式抽象";
    const repaired = repairCollapsedMarkdown(input);

    expect(repaired).toContain("## 2. 核心事实");
    expect(repaired).toContain("### 行业发展现状事实\n1. **标准层面**：MCP已经成为事实标准\n2. **产品层面**：主流平台都已支持Skill封装");
    expect(repaired).toContain("\n\n---\n\n## 3. 模式抽象");
  });

  it("leaves already structured markdown untouched", () => {
    const input = "# Title\n\n## Section\n- item one\n- item two";
    expect(isCollapsedMarkdown(input)).toBe(false);
    expect(repairCollapsedMarkdown(input)).toBe(input);
  });
});

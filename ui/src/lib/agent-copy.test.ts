import { describe, expect, it } from "vitest";

import {
  agentInvocationSourceLabels,
  formatAgentCount,
  formatAgentMoreIssues,
  getAgentCopy,
  thinkingEffortLabel,
} from "./agent-copy";

describe("agent-copy", () => {
  it("returns Chinese agent labels", () => {
    const copy = getAgentCopy("zh-CN");

    expect(copy.assignTask).toBe("分配任务");
    expect(copy.configurationRevisions).toBe("配置修订记录");
    expect(copy.noModelDetectedSelect).toBe("还没有检测到模型，请手动选择或输入。");
    expect(copy.addNewAgent).toBe("添加新智能体");
    expect(copy.createNewAgentIssueTitle).toBe("创建一个新的智能体");
    expect(copy.createNewAgentIssueDescription).toBe("请在这里说明你想创建什么样的智能体");
  });

  it("formats locale-aware agent helpers", () => {
    expect(getAgentCopy("zh-CN").all).toBe("全部");
    expect(getAgentCopy("zh-CN").filters).toBe("筛选");
    expect(getAgentCopy("zh-CN").newAgent).toBe("新建智能体");
    expect(formatAgentCount(5, "zh-CN")).toBe("5 个智能体");
    expect(formatAgentMoreIssues(3, "zh-CN")).toBe("还有 3 个任务");
    expect(agentInvocationSourceLabels("en").on_demand).toBe("On demand");
    expect(thinkingEffortLabel("xhigh", "zh-CN")).toBe("超高");
    expect(thinkingEffortLabel("plan", "en")).toBe("Plan");
  });
});

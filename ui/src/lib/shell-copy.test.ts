import { describe, expect, it } from "vitest";

import { getShellCopy, liveRunCountLabel, themeToggleLabel } from "./shell-copy";

describe("shell-copy", () => {
  it("returns Chinese navigation and issue labels", () => {
    const copy = getShellCopy("zh-CN");

    expect(copy.dashboard).toBe("仪表盘");
    expect(copy.newIssue).toBe("新建任务");
    expect(copy.attachments).toBe("附件");
    expect(copy.loadEarlierComments).toBe("加载更早评论");
  });

  it("returns Chinese shell labels for global navigation and command palette", () => {
    const copy = getShellCopy("zh-CN");

    expect(copy.skipToMainContent).toBe("跳到主要内容");
    expect(copy.addCompany).toBe("添加公司");
    expect(copy.selectCompany).toBe("选择公司");
    expect(copy.companies).toBe("公司");
    expect(copy.noCompanies).toBe("暂无公司");
    expect(copy.companySettings).toBe("公司设置");
    expect(copy.manageCompanies).toBe("管理公司");
    expect(copy.beta).toBe("测试版");
    expect(copy.newAgent).toBe("新建智能体");
    expect(copy.commandPaletteTitle).toBe("命令面板");
    expect(copy.commandPaletteDescription).toBe("搜索要执行的命令…");
    expect(copy.commandPaletteSearchPlaceholder).toBe("搜索任务、智能体、项目…");
    expect(copy.commandPaletteNoResults).toBe("没有找到结果。");
    expect(copy.commandPaletteCloseLabel).toBe("关闭");
  });

  it("returns English shell labels for the command palette", () => {
    const copy = getShellCopy("en");

    expect(copy.skipToMainContent).toBe("Skip to content");
    expect(copy.commandPaletteDescription).toBe("Search commands...");
    expect(copy.commandPaletteCloseLabel).toBe("Close");
  });

  it("formats theme toggles and live counts by locale", () => {
    expect(themeToggleLabel("dark", "zh-CN")).toBe("切换到深色模式");
    expect(themeToggleLabel("light", "en")).toBe("Switch to light mode");
    expect(liveRunCountLabel(3, "zh-CN")).toBe("3 运行中");
    expect(liveRunCountLabel(2, "en")).toBe("2 live");
  });
});

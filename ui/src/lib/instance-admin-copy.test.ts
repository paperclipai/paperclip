import { describe, expect, it } from "vitest";

import {
  formatHeartbeatSummary,
  formatInstanceAdminJobTriggerLabel,
  formatInstanceAdminStatusLabel,
  getInstanceAdminCopy,
} from "./instance-admin-copy";

describe("instance-admin-copy", () => {
  it("returns Chinese heartbeats and backup labels", () => {
    const copy = getInstanceAdminCopy("zh-CN");

    expect(copy.heartbeats.title).toBe("调度心跳");
    expect(copy.general.backupRetention).toBe("备份保留策略");
    expect(copy.experimental.toggleIsolatedWorkspacesAria).toBe("切换独立工作区实验功能");
    expect(copy.plugins.managerTitle).toBe("插件管理");
    expect(copy.adapters.managerTitle).toBe("适配器管理");
    expect(copy.plugins.breadcrumbPlugins).toBe("插件");
    expect(copy.adapters.breadcrumbAdapters).toBe("适配器");
    expect(copy.plugins.installPlugin).toBe("安装插件");
    expect(copy.plugins.noPluginsInstalled).toBe("尚未安装任何插件");
    expect(copy.adapters.installAdapter).toBe("安装适配器");
    expect(copy.adapters.hiddenFromMenus).toBe("已从菜单隐藏");
  });

  it("formats heartbeat summary counts", () => {
    expect(formatHeartbeatSummary({ active: 2, disabled: 3, companies: 1, locale: "zh-CN" })).toBe(
      "2 个启用 · 3 个停用 · 1 个公司",
    );
  });

  it("localizes job triggers and status labels", () => {
    expect(formatInstanceAdminJobTriggerLabel("manual", "zh-CN")).toBe("手动");
    expect(formatInstanceAdminJobTriggerLabel("schedule", "zh-CN")).toBe("计划");
    expect(formatInstanceAdminStatusLabel("failed", "zh-CN")).toBe("失败");
  });
});

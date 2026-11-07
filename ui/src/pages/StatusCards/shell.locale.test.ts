import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { estimateStatusCardCost, formatTokens, updateKindLabel } from "./format";

const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
afterEach(async () => { await i18n.changeLanguage("en"); });

it("localizes card estimates and update labels while keeping protocol kinds unchanged", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(formatTokens(940)).toBe("940 Token");
  expect(updateKindLabel("compile")).toBe("编译");
  expect(updateKindLabel("incremental")).toBe("增量更新");
  const policy = { mode: "interval" as const, intervalMinutes: 60, triggers: {} as never };
  expect(estimateStatusCardCost(policy).primary).toContain("每天最多约更新 24 次");
  expect(estimateStatusCardCost(policy).primary).toContain("每 60 分钟");
  expect(policy.mode).toBe("interval");
  await i18n.changeLanguage("en");
  expect(formatTokens(940)).toBe("940 tok");
  expect(updateKindLabel("compile")).toBe("compile");
});

it("formats complete count phrases without English plural fragments", async () => {
  await i18n.changeLanguage("en");
  expect(i18n.t("shell:skill_agents_using", { count: 1 })).toBe("1 agent uses this skill");
  expect(i18n.t("shell:skill_agents_using", { count: 2 })).toBe("2 agents use this skill");
  await i18n.changeLanguage("zh-CN");
  expect(i18n.t("shell:skill_agents_using", { count: 2 })).toBe("2 个智能体使用此技能");
  expect(i18n.t("shell:card_integrating_changes", { count: 2 })).toBe("正在整合 2 项变更…");
  expect(source("./StatusCardTile.tsx")).not.toContain('? "change" : "changes"');
  expect(source("../../components/skill-studio/AgentsUsingSkillDialog.tsx")).not.toContain('? "agent" : "agents"');
});

it("keeps shell terminology contextual rather than literal machine translations", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(i18n.t("shell:jump_to_live")).toBe("跳转到最新日志");
  expect(i18n.t("shell:invocation")).toBe("调用详情");
  expect(i18n.t("shell:checkout_state")).toBe("工作目录状态");
  expect(i18n.t("shell:open_task")).toBe("打开任务");
  expect(i18n.t("shell:briefs_is_paused")).toBe("简报已暂停。");
});

it("uses the shell namespace for cloud creation errors and core shell menus", () => {
  const app = source("../../App.tsx");
  expect(app).not.toContain('t("app.cloudCreateUnavailable")');
  expect(app).toContain('shell:cloudCreateUnavailable');
  for (const file of ["CompanySwitcher.tsx", "CompanySettingsSidebar.tsx", "CompanySettingsSidebar.production.tsx", "Sidebar.production.tsx", "SidebarAccountMenu.production.tsx", "SidebarAgents.tsx", "SidebarAgents.production.tsx"]) {
    const contents = source("../../components/" + file);
    expect(contents).toContain('useTranslation("shell")');
    expect(contents).not.toMatch(/(?:aria-label|label|placeholder)="(?:Open account menu|Agents|Settings|General|Search|Dashboard|Members)"/);
  }
});

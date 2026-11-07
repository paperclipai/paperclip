import { afterEach, describe, expect, it } from "vitest";
import { i18n, t } from "@/i18n";
import en from "@/i18n/catalogs/en/work.json";
import zh from "@/i18n/catalogs/zh-CN/work.json";
import { assertValidLocaleMessages } from "@/i18n/locale-validation";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("work catalog", () => {
  it("keeps keys and interpolation variables aligned", () => {
    expect(() => assertValidLocaleMessages(zh, en)).not.toThrow();
  });
  it("interpolates complete feedback and usage sentences", async () => {
    await i18n.changeLanguage("en");
    expect(t("work:messages.tasksLoaded", { count: 50 })).toBe("50 tasks loaded. Load more to include them in filters.");
    expect(t("work:messages.museUsage", { owners: "Ada" })).toBe("Ada's Muse activity has no reported usage or cost. Totals below show recorded organization charges only. Paperclip cannot enforce a Muse spend ceiling.");
    await i18n.changeLanguage("zh-CN");
    expect(t("work:messages.tasksLoaded", { count: 50 })).toBe("已加载 50 个任务。加载更多任务以将其纳入筛选。");
    expect(t("work:messages.museUsage", { owners: "Ada" })).toContain("Ada 的 Muse 活动未报告用量或成本。");
  });
  it("renders complete count messages in both languages at call time", async () => {
    await i18n.changeLanguage("en");
    expect(t("work:counts.tasks", { count: 1 })).toBe("1 task");
    expect(t("work:counts.tasks", { count: 2 })).toBe("2 tasks");
    await i18n.changeLanguage("zh-CN");
    expect(t("work:counts.tasks", { count: 1 })).toBe("1 个任务");
    expect(t("work:counts.tasks", { count: 2 })).toBe("2 个任务");
    expect(t("work:counts.projects", { count: 3 })).toBe("3 个项目");
    expect(t("work:counts.runs", { count: 2 })).toBe("2 次运行");
  });
});

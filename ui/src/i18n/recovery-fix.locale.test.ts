import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./index";
import { sanitizedSetupErrorMessage } from "@/pages/apps/chat/chat-setup-error";

const skillName = "Paperclip / Claude 技能 <skill-42>";
const countPhrases = [
  ["skill_agents_using", "{{count}} agent uses this skill", "{{count}} agents use this skill", "{{count}} 个智能体使用此技能"],
  ["skill_agents_count", "{{count}} agent", "{{count}} agents", "{{count}} 个智能体"],
  ["skill_desired_count", "{{count}} agent has this skill in their desired set.", "{{count}} agents have this skill in their desired set.", "{{count}} 个智能体已将此技能加入其期望技能集。"],
  ["skill_copy_switched", "Created a copy of {{skillName}} and switched {{count}} agent to it.", "Created a copy of {{skillName}} and switched {{count}} agents to it.", "已创建 {{skillName}} 的副本，并将 {{count}} 个智能体切换为使用该副本。"],
  ["skill_copy_switch_count", "Create copy & switch {{count}} agent", "Create copy & switch {{count}} agents", "创建副本并切换 {{count}} 个智能体"],
  ["card_today_updates", "Today: {{count}} update", "Today: {{count}} updates", "今日更新 {{count}} 次"],
  ["card_integrating_changes", "Integrating {{count}} change…", "Integrating {{count}} changes…", "正在整合 {{count}} 项变更…"],
  ["card_changes_since_update", "{{count}} change since last update", "{{count}} changes since last update", "自上次更新以来有 {{count}} 项变更"],
] as const;

const connectionPhrases = [
  ["repairPermissionHint", "Reconnect the app and allow the permissions required for this action.", "请重新连接此应用，并授予执行此操作所需的权限。"],
  ["interactivity", "Interactivity", "交互功能"],
  ["setupErrorFallback", "Check the required values and provider access, then try again.", "请检查必填值及服务提供商的访问权限，然后重试。"],
] as const;

afterEach(async () => { await i18n.changeLanguage("en"); });

describe.each(["en", "zh-CN"] as const)("interrupted catalog recovery in %s", (locale) => {
  it.each(countPhrases)("interpolates %s as a complete count phrase", async (key, singular, plural, chinese) => {
    await i18n.changeLanguage(locale);
    for (const count of [0, 1, 2]) {
      const pattern = locale === "zh-CN" ? chinese : count === 1 ? singular : plural;
      const expected = pattern.replaceAll("{{count}}", String(count)).replaceAll("{{skillName}}", skillName);
      expect(i18n.t(`shell:${key}`, { count, skillName })).toBe(expected);
      expect(i18n.getResource(locale, "shell", key)).toBeDefined();
    }
  });

  it.each(connectionPhrases)("resolves %s from the requested locale", async (key, english, chinese) => {
    await i18n.changeLanguage(locale);
    expect(i18n.t(`connections:${key}`)).toBe(locale === "en" ? english : chinese);
    expect(i18n.getResource(locale, "connections", key)).toBe(locale === "en" ? english : chinese);
  });

  it("uses localized setup fallbacks without changing redaction or provider IDs", async () => {
    await i18n.changeLanguage(locale);
    const fallback = locale === "en"
      ? "Check the required values and provider access, then try again."
      : "请检查必填值及服务提供商的访问权限，然后重试。";
    for (const error of [undefined, {}, new Error(" \n\t ")]) {
      expect(sanitizedSetupErrorMessage(error, {})).toBe(fallback);
    }
    expect(sanitizedSetupErrorMessage(new Error("Slack app A0123 rejected token-42"), { botToken: "token-42" }))
      .toBe("Slack app A0123 rejected [redacted]");
  });
});

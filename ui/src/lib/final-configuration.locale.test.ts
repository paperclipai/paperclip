import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { EXPORT_CATEGORY_LABELS } from "./company-export-selection";
import { formatCleanupOutcome, formatSilenceAgeMs } from "./source-resolved-watchdog-fold";
import { formatTimelineWorkspaceLabel } from "./issue-timeline-events";
import { resolveAgentCreatorLabel } from "./agent-creator";
import { groupAttentionItems } from "./attention";
import { getAgentRoleLabel } from "@/adapters/display-translations";
import { taskPanelSkillTab } from "./task-side-panel-state";
import { providerDisplayName, quotaSourceDisplayName } from "./utils";

it("retains synthetic skill-tab display provenance and unknown provider labels, including prototype collisions", async () => {
  await i18n.changeLanguage("en");
  const tab = taskPanelSkillTab("raw-id"); const custom = taskPanelSkillTab("custom", "Skill");
  expect(tab.label).toBe("Skill");
  await i18n.changeLanguage("zh-CN");
  expect(tab.label).toBe("技能"); expect(custom.label).toBe("Skill");
  expect(tab.payload).toEqual({kind:"skill",skillId:"raw-id"});
  for (const label of ["__proto__", "constructor", "toString", "Raw_Provider"]) {
    expect(providerDisplayName(label)).toBe(label); expect(quotaSourceDisplayName(label)).toBe(label);
  }
  expect(providerDisplayName("openai")).toBe("OpenAI");
  await i18n.changeLanguage("en"); expect(tab.label).toBe("Skill");
});

afterEach(async () => { await i18n.changeLanguage("en"); });
it("reads closed configuration metadata and plural age labels in the live locale with byte-exact unknown controls", async () => {
  const categories = EXPORT_CATEGORY_LABELS;
  for (const [locale, expected] of [["en", ["Agents", "terminated", "1 minute", "2 minutes", "1 hour", "1h 1m", "None", "Unknown user", "Critical"]], ["zh-CN", ["智能体", "已终止", "1 分钟", "2 分钟", "1 小时", "1 小时 1 分钟", "无", "未知用户", "严重"]], ["en", ["Agents", "terminated", "1 minute", "2 minutes", "1 hour", "1h 1m", "None", "Unknown user", "Critical"]]] as const) {
    await i18n.changeLanguage(locale);
    const groups = groupAttentionItems([{ id:"raw",severity:"critical" } as never],"severity");
    expect([categories.agents,formatCleanupOutcome("terminated"),formatSilenceAgeMs(60000),formatSilenceAgeMs(120000),formatSilenceAgeMs(3600000),formatSilenceAgeMs(3660000),formatTimelineWorkspaceLabel({} as never),resolveAgentCreatorLabel("u",[{principalId:"u",user:{}},{principalId:"v",user:{name:"Raw"}}] as never),groups[0].label]).toEqual(expected);
    expect(formatTimelineWorkspaceLabel({label:"None"} as never)).toBe("None");
    for (const raw of ["__proto__", "constructor", "toString", "vendor_outcome", "terminated diagnostic"]) expect(formatCleanupOutcome(raw)).toBe(raw);
    for (const raw of ["__proto__", "constructor", "Engineer", "custom_role"]) expect(getAgentRoleLabel(raw)).toBe(raw);
  }
  expect(formatSilenceAgeMs(null)).toBeNull();
});

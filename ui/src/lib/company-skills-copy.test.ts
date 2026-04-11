import { describe, expect, it } from "vitest";

import { getCompanySkillsCopy } from "./company-skills-copy";

describe("company-skills-copy", () => {
  it("returns Chinese list and pane labels", () => {
    const copy = getCompanySkillsCopy("zh-CN");

    expect(copy.newSkill.namePlaceholder).toBe("技能名称");
    expect(copy.breadcrumbs.detail).toBe("详情");
    expect(copy.list.noMatches).toBe("没有技能匹配当前筛选。");
    expect(copy.pane.selectSkill).toBe("选择一个技能以查看文件。");
    expect(copy.pane.checkForUpdates).toBe("检查更新");
  });
});

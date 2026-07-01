import { describe, expect, it } from "vitest";
import {
  getDefaultOnboardingIssueContent,
  getDefaultOnboardingProjectName,
  localizeKnownAgentCapabilities,
  localizeKnownAgentLabel,
  localizeKnownOnboardingIssueDescription,
  localizeKnownOnboardingIssueTitle,
  localizeKnownOnboardingProjectName,
  ONBOARDING_ISSUE_DESCRIPTION_EN,
  ONBOARDING_ISSUE_TITLE_EN,
  ONBOARDING_PROJECT_NAME_EN,
} from "./onboarding-localization";

describe("onboarding localization", () => {
  it("returns Chinese defaults for known onboarding seeds", () => {
    expect(getDefaultOnboardingProjectName("zh-CN")).toBe("引导");
    expect(getDefaultOnboardingIssueContent("zh-CN")).toEqual({
      title: "招聘第一位工程师并制定招聘计划",
      description: `你是 CEO，由你来为公司确定方向。

- 招聘第一位创始工程师
- 制定招聘计划
- 将路线图拆解为具体任务，并开始委派工作`,
    });
  });

  it("localizes existing English onboarding data at render time", () => {
    expect(localizeKnownOnboardingProjectName(ONBOARDING_PROJECT_NAME_EN, "zh-CN")).toBe("引导");
    expect(localizeKnownOnboardingIssueTitle(ONBOARDING_ISSUE_TITLE_EN, "zh-CN")).toBe(
      "招聘第一位工程师并制定招聘计划",
    );
    expect(localizeKnownOnboardingIssueDescription(ONBOARDING_ISSUE_DESCRIPTION_EN, "zh-CN")).toContain(
      "招聘第一位创始工程师",
    );
  });

  it("keeps unrelated content unchanged", () => {
    expect(localizeKnownOnboardingProjectName("Roadmap", "zh-CN")).toBe("Roadmap");
    expect(localizeKnownOnboardingIssueTitle("Ship the MVP", "zh-CN")).toBe("Ship the MVP");
    expect(localizeKnownOnboardingIssueDescription("Custom description", "zh-CN")).toBe("Custom description");
  });

  it("localizes known default agent names and titles", () => {
    expect(localizeKnownAgentLabel("CEO", "zh-CN", "ceo")).toBe("首席执行官");
    expect(localizeKnownAgentLabel("首席执行官", "en", "ceo")).toBe("CEO");
    expect(localizeKnownAgentLabel("CTO", "zh-CN")).toBe("首席技术官");
    expect(localizeKnownAgentLabel("Chief Marketing Officer", "zh-CN", "cmo")).toBe("首席营销官");
    expect(localizeKnownAgentLabel("Chief Technology Officer", "zh-CN", "cto")).toBe("首席技术官");
    expect(localizeKnownAgentLabel("Custom Agent", "zh-CN")).toBe("Custom Agent");
  });

  it("localizes known default agent capability summaries", () => {
    expect(
      localizeKnownAgentCapabilities(
        "Owns technical strategy and architecture, leads engineering execution, breaks roadmap into deliverables, delegates coding work, and reports progress to the CEO.",
        "zh-CN",
      ),
    ).toContain("负责技术战略和架构");
    expect(localizeKnownAgentCapabilities("Custom capability", "zh-CN")).toBe("Custom capability");
  });
});

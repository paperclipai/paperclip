import { describe, expect, it } from "vitest";
import {
  formatFeedbackSharingStatus,
  formatOpenClawInvitePrompt,
  getCompanySettingsCopy,
} from "./company-settings-copy";

describe("company-settings-copy", () => {
  it("returns Chinese company settings labels", () => {
    const copy = getCompanySettingsCopy("zh-CN");

    expect(copy.title).toBe("公司设置");
    expect(copy.companyName).toBe("公司名称");
    expect(copy.brandColor).toBe("品牌色");
    expect(copy.requireBoardApproval).toBe("新雇员需经董事会批准");
  });

  it("formats feedback sharing status", () => {
    expect(formatFeedbackSharingStatus({ locale: "zh-CN", enabledAt: null, enabledBy: null })).toBe("当前未启用共享。");
  });

  it("formats invite prompt copy in Chinese", () => {
    const prompt = formatOpenClawInvitePrompt({
      locale: "zh-CN",
      onboardingTextUrl: "https://paperclip.example/api/invites/abc/onboarding.txt",
      connectionCandidates: ["http://10.0.0.4:3100"],
      testResolutionUrl: "https://paperclip.example/api/invites/abc/test-resolution",
    });

    expect(prompt).toContain("你受邀加入一个 Paperclip 组织。");
    expect(prompt).toContain("- https://paperclip.example/api/invites/abc/onboarding.txt");
    expect(prompt).toContain("此接入流程适用于 OpenClaw Gateway。");
    expect(prompt).toContain("你必须测试 Paperclip 到 gateway 的连通性，请调用： https://paperclip.example/api/invites/abc/test-resolution?url=<urlencoded-gateway-url>");
    expect(prompt).toContain("不要假设你的 172.x 一定能从 Paperclip 访问到。请进行测试。");
    expect(prompt).not.toContain("Do not assume your 172.x is necessarily reachable from Paperclip. Test it.");
  });
});

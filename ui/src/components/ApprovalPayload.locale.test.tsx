import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { approvalLabel, CeoStrategyPayload, HireAgentPayload, typeLabel } from "./ApprovalPayload";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("approval display localization", () => {
  it("distinguishes an agent job title from a document title without changing payload values", async () => {
    const payload = { name: "QA 原名", title: "Senior <Engineer>", role: "engineer" };
    const original = { ...payload };
    await i18n.changeLanguage("zh-CN");
    const hire = renderToStaticMarkup(createElement(HireAgentPayload, { payload }));
    const strategy = renderToStaticMarkup(createElement(CeoStrategyPayload, { payload: { title: "Plan 原文", plan: "User plan" } }));
    expect(hire).toContain("职务");
    expect(hire).toContain("Senior &lt;Engineer&gt;");
    expect(hire).toContain("QA 原名");
    expect(strategy).toContain("标题");
    expect(strategy).toContain("Plan 原文");
    expect(payload).toEqual(original);
    await i18n.changeLanguage("en");
    expect(renderToStaticMarkup(createElement(HireAgentPayload, { payload }))).toContain("Title");
  });

  it("resolves known approval types at call time in both language directions", async () => {
    const english = ["Hire Agent", "CEO Strategy", "Budget Override", "Board Approval"];
    const keys = ["hire_agent", "approve_ceo_strategy", "budget_override_required", "request_board_approval"];
    expect(keys.map(key => typeLabel[key])).toEqual(english);
    await i18n.changeLanguage("zh-CN");
    expect(keys.map(key => typeLabel[key])).toEqual(["聘用智能体", "CEO 战略", "预算例外审批", "管理者审批"]);
    expect(approvalLabel("hire_agent", { name: "QA <Owner>" })).toBe("聘用智能体：QA <Owner>");
    expect(approvalLabel("vendor_custom_code")).toBe("vendor_custom_code");
    await i18n.changeLanguage("en");
    expect(keys.map(key => typeLabel[key])).toEqual(english);
    expect(approvalLabel("hire_agent", { name: "QA <Owner>" })).toBe("Hire Agent: QA <Owner>");
  });
});

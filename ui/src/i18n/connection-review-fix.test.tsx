import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Trans, I18nextProvider } from "react-i18next";
import { i18n } from "./index";
import { sanitizedSetupErrorMessage } from "@/pages/apps/chat/chat-setup-error";
import { connectionDisplayNameForOwner } from "@/pages/apps/connection-owner";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("keeps dismissal separate from revocation, deletion, and pool removal", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(i18n.t("connections:dismiss_new_token_6c68d3e")).toBe("关闭新令牌提示");
  expect(i18n.t("connections:dismiss_70afe9e")).toBe("关闭");
  expect(i18n.t("connections:open_permissions_4f6ff2e")).toBe("打开“权限” →");
  expect(i18n.t("connections:decline_288fca0")).toBe("拒绝");
  expect(i18n.t("connections:remove_0853af0", { connectionName: "A" })).toBe("移除 A");
});

it("renders complete counts and natural named sentence order without changing names", async () => {
  const name = "Client <raw-42> / Alexis";
  for (const locale of ["en", "zh-CN"]) {
    await i18n.changeLanguage(locale);
    expect(i18n.t("connections:open_in_001749e", { name })).toBe(locale === "en" ? `Open in ${name}` : `在 ${name} 中打开`);
    for (const count of [0, 1, 2]) {
      expect(i18n.t("connections:ready_to_connect_295127e", { count })).toBe(locale === "en" ? `${count} ${count === 1 ? "sheet" : "sheets"} ready to connect.` : `${count} 份表格已准备好连接。`);
      expect(i18n.t("connections:new_your_ok_455e32a", { count })).toBe(locale === "en" ? `${count} new ${count === 1 ? "action needs" : "actions need"} your OK.` : `有 ${count} 项新的操作需要你批准。`);
    }
  }
});

it("preserves link and emphasis nodes in reordered instructions and token revocation", async () => {
  await i18n.changeLanguage("zh-CN");
  const permission = renderToStaticMarkup(<I18nextProvider i18n={i18n}><Trans ns="connections" i18nKey="want_to_test_it_turn_it_on_79ee4f5" values={{ agentName: "Alexis" }} components={{ permissions: <a href="/permissions" /> }} /></I18nextProvider>);
  expect(permission).toContain('<a href="/permissions">权限</a>中为 Alexis 启用此操作');
  const token = renderToStaticMarkup(<I18nextProvider i18n={i18n}><Trans ns="connections" i18nKey="any_client_using_c238eac" values={{ tokenName: "pcgw_42" }} components={{ token: <strong /> }} /></I18nextProvider>);
  expect(token).toContain('使用 <strong>pcgw_42</strong> 的客户端将立即无法访问网关');
  expect(token).toContain("此操作无法撤销");
});

it("preserves unknown diagnostics and customized names in either locale", async () => {
  const diagnostic = "vendor_UNKNOWN_42: tenant.example / pcgw_X / operation_xyz";
  const customName = "Alexis’ CUSTOM <opaque-42>";
  for (const locale of ["en", "zh-CN"]) {
    await i18n.changeLanguage(locale);
    expect(sanitizedSetupErrorMessage(new Error(diagnostic), undefined)).toBe(diagnostic);
    expect(connectionDisplayNameForOwner({ name: customName }, "Notion", { label: "Alexis", image: null })).toBe(customName);
    expect(i18n.t("connections:s_18addd3", { label: "Alexis", context: "s" })).toBe(locale === "en" ? "Alexis’" : "Alexis的");
  }
});

it("keeps linked instructions complete rather than relying on English fragments", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(i18n.t("connections:reviewBArcadeKeyInstructions")).toBe("在 <arcade>Arcade</arcade> 中为此网关所属的项目创建密钥。密钥会被安全存储，仅用于账号同步。");
  expect(i18n.t("connections:reviewBApproveTestInstructions")).toBe("请在<review>审批选项卡</review>中批准此操作以完成测试。你也可以取消请求。");
  expect(i18n.t("connections:reviewBAddConnectionInstructions")).toBe("从 <apps>应用</apps> 中添加一个连接，为你的智能体提供所需工具。");
});

it("does not strengthen operator evidence into independent confirmation or remove security prerequisites", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(i18n.t("connections:reviewBOperatorAttested")).toBe("操作者声明");
  expect(i18n.t("connections:reviewBUnconfirmed")).toBe("未确认");
  expect(i18n.t("connections:reviewBRailwayPrerequisites")).toContain("注册公钥并验证主机密钥");
  expect(i18n.t("connections:reviewBGitHubPermissions")).toContain("Metadata 保持只读");
});

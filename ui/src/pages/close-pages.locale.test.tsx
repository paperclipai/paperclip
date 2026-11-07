// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { getAppStoreDefinition, type ToolConnection } from "@paperclipai/shared";
import { i18n, useTranslation } from "@/i18n";
import { AGENT_DETAIL_NAVIGATION, agentDetailViewLabel, agentDetailHref } from "./agent-detail-navigation";
import { TOKEN_STATUS_LABEL, allowedToolsLabel } from "./apps/gateways/gateway-helpers";
import { audienceSummary, connectionNameForCredentialPolicy } from "./apps/connection-identity";
import { SetupPanel } from "./apps/app-detail/SetupPanel";
import { ResponsibleUserDenialUxLab } from "./ResponsibleUserDenialUxLab";
import { getAgentRoleLabel } from "@/adapters/display-translations";
import { getPageValueLabel } from "./tools/shared";
function DeepNavigation() {
  useTranslation();
  return <nav aria-label={agentDetailViewLabel("permissions")}><span>{AGENT_DETAIL_NAVIGATION[0].items[2].label}</span><span>{getAgentRoleLabel("engineer")}</span><span>{getPageValueLabel("active")}</span></nav>;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => { await i18n.changeLanguage("en"); }); });

it("resolves imported deep navigation and closed status labels at call time", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(agentDetailViewLabel("secrets")).toBe("密钥与变量");
  expect(AGENT_DETAIL_NAVIGATION[0].items[2].label).toBe("执行框架 / 运行时");
  expect(TOKEN_STATUS_LABEL.active).toBe("有效");
  expect(agentDetailHref("agent_RAW", "secrets")).toBe("/agents/agent_RAW/secrets");
  await i18n.changeLanguage("en");
  expect(agentDetailViewLabel("secrets")).toBe("Secrets & variables");
  expect(TOKEN_STATUS_LABEL.active).toBe("Active");
});

it("renders 0/1/2 members as complete messages while posted names stay canonical", async () => {
  for (const locale of ["en", "zh-CN"]) {
    await i18n.changeLanguage(locale);
    for (const count of [0, 1, 2]) {
      expect(audienceSummary({ members: Array.from({ length: count }, () => ({})) } as Parameters<typeof audienceSummary>[0])).toBe(locale === "en" ? count === 0 ? "All organization members" : `${count} selected ${count === 1 ? "member" : "members"}` : count === 0 ? "所有组织成员" : `已选择 ${count} 位成员`);
    }
    expect(connectionNameForCredentialPolicy("Slack", "shared")).toBe("Slack for the organization");
  }
});

it("updates mounted deep navigation and leaves unknown state/role identifiers raw", async () => {
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<DeepNavigation />));
    expect(host.textContent).toContain("Harness / Runtime");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(host.textContent).toContain("执行框架 / 运行时");
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("权限 / 信任");
    expect(getPageValueLabel("vendor_UNKNOWN_42", true)).toBe("vendor_UNKNOWN_42");
    expect(getAgentRoleLabel("raw_ROLE_42")).toBe("raw_ROLE_42");
  } finally { await act(async () => root.unmount()); }
});

it("renders shipped lab outcome labels without changing fixture identities or diagnostics", async () => {
  await i18n.changeLanguage("zh-CN");
  const html = renderToStaticMarkup(<ResponsibleUserDenialUxLab />);
  expect(html).not.toContain(">failed<");
  expect(html).not.toContain("Last useful action");
  expect(html).toContain("Ada Lovelace");
  expect(html).toContain("RESPONSIBLE_USER_UNAUTHORIZED");
  expect(html).toContain("1 分 4 秒");
});

it("SSR and mounted nested setup retain drafts and identical request configs on language switch", async () => {
  const save = vi.fn();
  const connection = { id: "conn_RAW", config: { opaque: "do_NOT_translate" } } as unknown as ToolConnection;
  const props = { connection, galleryEntry: getAppStoreDefinition("google-sheets")!, onUpdateConfig: save, configUpdateDisabled: false, agentsSummary: "Agent RAW", permissionsSummary: null, permissionsLoading: false, onOpenPermissions: vi.fn() };
  await i18n.changeLanguage("zh-CN");
  expect(renderToStaticMarkup(<SetupPanel {...props} />)).toContain("管理权限");
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SetupPanel {...props} />));
    const input = host.querySelector("input")!;
    const enter = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); };
    await enter("https://docs.google.com/spreadsheets/d/RAW_123/edit");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(input.value).toContain("RAW_123");
    expect(host.textContent).toContain("Manage permissions");
    const add = [...host.querySelectorAll("button")].find(b => b.textContent === "Add sheet")!;
    await act(async () => add.click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ opaque: "do_NOT_translate", allowedSpreadsheetIds: ["RAW_123"] });
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    const addZh = [...host.querySelectorAll("button")].find(b => b.textContent === i18n.t("connections:add_sheet_5b926f0"))!;
    await act(async () => addZh.click());
    expect(host.textContent).toContain("请粘贴 Google Sheets 链接。");
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(host.textContent).toContain("Paste a Google Sheets link.");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    await enter("https://docs.google.com/spreadsheets/d/RAW_123/edit");
    await act(async () => addZh.click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { AgentCapsule } from "./AgentCapsule";
import { ModeBadge } from "./access/ModeBadge";
import { ExternalAgentInviteContent } from "./new-agent/ExternalAgentInviteContent";
import { Dialog, DialogContent } from "./ui/dialog";
import { MemoryRouter } from "@/lib/router";
import { ProviderSubscriptionCard, ProviderApiKeyCard } from "./AdapterLoginChrome";
import { SecretPopoverForm } from "./environment-variables-editor/CreateSecretPopover";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { AccessStepContent } from "@/features/connections/ConnectionSetupFlow";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("localizes complete authentication instructions while preserving URLs and provider names", async () => {
  await i18n.changeLanguage("en");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  act(() => root.render(<><ProviderSubscriptionCard providerName="RawProvider" authorizationUrl="https://example.com/authorize" mode="submitted_code"><input defaultValue="raw code" /></ProviderSubscriptionCard><ProviderApiKeyCard providerName="RawProvider" value="RawKey" onChange={() => {}} onSubmit={() => {}} /></>));
  expect(host.textContent).toContain("Sign in to RawProvider then come back and enter authorization code");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).toContain("登录 RawProvider，然后返回并输入授权码");
  expect(host.textContent).toContain("提供 RawProvider API 密钥以连接");
  expect(host.querySelector('a')?.href).toBe("https://example.com/authorize");
  expect(Array.from(host.querySelectorAll('input'), input => input.value)).toEqual(["raw code", "RawKey"]);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(host.textContent).toContain("Provide your RawProvider API key to connect");
  act(() => root.unmount()); host.remove();
});

it("resolves a stored secret failure at render time, not by matching unknown error messages", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  await i18n.changeLanguage("en");
  let failure: unknown = undefined;
  act(() => root.render(<Popover defaultOpen><PopoverTrigger>Open</PopoverTrigger><PopoverContent><SecretPopoverForm mode="create" initialName="raw_name" initialValue="RawKey" onCancel={() => {}} onSubmit={async () => { throw failure; }} /></PopoverContent></Popover>));
  const clickSubmit = async () => { const button = Array.from(document.querySelectorAll('button')).find(b => /Create.*bind|创建.*绑定/.test(b.textContent ?? ""))!; await act(async () => button.click()); };
  await clickSubmit();
  expect(document.body.textContent).toContain("Failed to create secret");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(document.body.textContent).toContain("创建密钥失败");
  failure = new Error("Failed to create secret"); await clickSubmit();
  expect(document.body.textContent).toContain("Failed to create secret");
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("RawKey");
  act(() => root.unmount()); host.remove();
});

it("translates connection access choice metadata without changing grant and install payload IDs or server diagnostics", async () => {
  await i18n.changeLanguage("en");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root); const choices: string[] = [];
  act(() => root.render(<AccessStepContent agents={[]} authKind="oauth" grantKinds={["user", "agent", "organization"]} grantKind="user" setGrantKind={v => choices.push(v)} installChoice="all" setInstallChoice={v => choices.push(v)} installAgentIds={new Set()} setInstallAgentIds={() => {}} githubIdentity submitLabel="Raw submit" onBack={() => {}} onContinue={() => {}} />));
  expect(host.textContent).toContain("My GitHub account");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).toContain("我的 GitHub 账号");
  expect(host.textContent).toContain("仅限我选择的智能体");
  const radio = Array.from(host.querySelectorAll<HTMLElement>('[role="radio"]')).find(el => el.textContent?.includes("专用账号"))!;
  act(() => radio.click()); expect(choices).toEqual(["agent", "specific"]);
  expect(host.textContent).toContain("Raw submit");
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(host.textContent).toContain("My GitHub account");
  act(() => root.unmount()); host.remove();
});

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { act(() => { roots.splice(0).forEach(root => root.unmount()); }); document.body.innerHTML = ""; await act(async () => { await i18n.changeLanguage("en"); }); });
it("updates closed configuration labels on a mounted language roundtrip without changing a user label or draft", async () => {
  await i18n.changeLanguage("en");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  act(() => root.render(<><input defaultValue="raw draft" /><AgentCapsule state="configured" /><AgentCapsule state="slot" aria-label="agent online" /><ModeBadge deploymentMode="local_trusted" /><ModeBadge deploymentMode="authenticated" /><ModeBadge deploymentMode="authenticated" deploymentExposure="public" /></>));
  const input = host.querySelector("input")!; input.value = "unsaved 原文";
  expect(host.textContent).toContain("Local trustedAuthenticated privateAuthenticated public");
  expect(host.querySelector('[data-state="configured"]')?.getAttribute("aria-label")).toBe("agent configured, offline");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).toContain("本地信任已认证（私有）已认证（公开）");
  expect(host.querySelector('[data-state="configured"]')?.getAttribute("aria-label")).toBe("智能体已配置，离线");
  expect(host.querySelector('[data-state="slot"]')?.getAttribute("aria-label")).toBe("agent online");
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(host.textContent).toContain("Local trustedAuthenticated privateAuthenticated public");
  expect(host.querySelector("input")).toBe(input); expect(input.value).toBe("unsaved 原文");
  act(() => root.unmount()); host.remove();
});

it("translates external invite role metadata at display time while preserving select IDs, names and prompts", async () => {
  await i18n.changeLanguage("en");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  const values: unknown[] = []; const draft = { name: "Engineer", role: "engineer" as const };
  act(() => root.render(<MemoryRouter><Dialog open><DialogContent><ExternalAgentInviteContent preset="muse" companyName="General" prompt="raw prompt Engineer" connection={{ phase: "waiting" }} museDraft={draft} onMuseDraftChange={value => values.push(value)} onMuseContinue={() => {}} onSelect={() => {}} onBack={() => {}} onClose={() => {}} onCopied={() => {}} onRetry={() => {}} onNewPrompt={() => {}} /></DialogContent></Dialog></MemoryRouter>));
  const select = document.querySelector("select")!; const ids = Array.from(select.options, option => option.value);
  expect(select.querySelector('[value="engineer"]')?.textContent).toBe("Engineer");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(select.querySelector('[value="engineer"]')?.textContent).toBe("工程师");
  expect(Array.from(select.options, option => option.value)).toEqual(ids);
  expect(document.querySelector<HTMLInputElement>('input')?.value).toBe("Engineer");
  select.value = "designer"; act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
  expect(values).toEqual([{name: "Engineer", role: "designer"}]);
  expect(draft).toEqual({name:"Engineer",role:"engineer"});
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(select.querySelector('[value="engineer"]')?.textContent).toBe("Engineer");
  act(() => root.unmount()); host.remove();
});

// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { AiConnectionIdentity } from "./AiConnectionIdentity";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import type { ConnectionGrant } from "@paperclipai/shared";
import type { AiConnectionSummary } from "./model";

let root: Root;
let host: HTMLDivElement;
const requirement = { companyId: "company", provider: "anthropic", method: "subscription" } as const;
const shared: AiConnectionSummary = {
  ...requirement, id: "shared-id", grantId: "grant-id", name: "Account name: Board",
  ownership: "shared", ownerUserId: "other-user", status: "connected",
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  flushSync(() => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
});

it("retranslates picker and accessibility labels en/ru/en while preserving account selection IDs", () => {
  const onChange = vi.fn();
  const onConnect = vi.fn();
  flushSync(() => root.render(<AiConnectionPicker
    requirement={requirement} connections={[shared]}
    value={{ provider: "anthropic", method: "subscription", mode: "shared", connectionId: shared.id, grantId: shared.grantId }}
    currentUserId="alice" agentId="agent" agentName="Agent"
    onChange={onChange} onConnect={onConnect}
  />));
  const selected = host.querySelector('button[aria-label="Account name: Board"]') as HTMLButtonElement;
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  for (const [locale, label, method, responsible] of [
    ["ru", "Подключение к ИИ", "Подписка Claude", "Подключение ответственного пользователя"],
    ["en", "AI connection", "Claude subscription", "Responsible user’s connection"],
  ]) {
    flushSync(() => { void i18n.changeLanguage(locale); });
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(label);
    expect(host.textContent).toContain(method);
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(responsible);
    expect(host.querySelector('button[aria-label="Account name: Board"]')).toBe(selected);
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
  }
  flushSync(() => selected.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    provider: "anthropic", method: "subscription", mode: "shared",
    connectionId: "shared-id", grantId: "grant-id",
  });
});

it("keeps unhealthy shared choices disabled and retranslates their reason", () => {
  const onChange = vi.fn();
  flushSync(() => root.render(<AiConnectionPicker
    requirement={requirement} connections={[{ ...shared, status: "revoked" }]}
    currentUserId="alice" agentId="agent" agentName="Agent"
    onChange={onChange} onConnect={vi.fn()}
  />));
  const choice = host.querySelector('button[aria-label="Account name: Board"]') as HTMLButtonElement;
  expect(choice.disabled).toBe(true);
  expect(choice.textContent).toContain("Revoked");
  flushSync(() => { void i18n.changeLanguage("ru"); });
  expect(choice.disabled).toBe(true);
  expect(choice.textContent).toContain("Доступ отозван");
  flushSync(() => choice.click());
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps a personal API-key default for a subscription requirement while switching languages", () => {
  const onChange = vi.fn();
  const personal = { ...shared, id: "personal-api", grantId: "personal-grant", name: "API user draft", ownership: "personal", ownerUserId: "alice", method: "api_key", isDefault: true } as const;
  flushSync(() => root.render(<AiConnectionPicker
    requirement={requirement} connections={[personal]}
    value={{ provider: "anthropic", method: "subscription", mode: "responsible_user" }}
    currentUserId="alice" agentId="agent" agentName="Agent"
    onChange={onChange} onConnect={vi.fn()}
  />));
  const choice = host.querySelector("button") as HTMLButtonElement;
  for (const [locale, description] of [
    ["ru", "Для задач других пользователей используются их собственные подключения к Claude."],
    ["en", "Other users’ tasks use their own Claude connection."],
  ]) {
    flushSync(() => { void i18n.changeLanguage(locale); });
    expect(choice.textContent).toContain("API user draft");
    expect(choice.textContent).toContain(description);
    expect(choice.getAttribute("aria-pressed")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  }
  flushSync(() => choice.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
  expect(personal.name).toBe("API user draft");
});

it("translates ownership but never interprets a person's name as built-in copy", () => {
  flushSync(() => root.render(<AiConnectionIdentity connection={{ ...shared, ownership: "personal", ownerName: "You" }} />));
  expect(host.textContent).toContain("Personal · You");
  flushSync(() => { void i18n.changeLanguage("ru"); });
  expect(host.textContent).toContain("Личное · You");
  expect(host.textContent).toContain("Account name: Board");
  flushSync(() => { void i18n.changeLanguage("en"); });
  expect(host.textContent).toContain("Personal · You");
});

it("updates the provider-scoped default account copy without changing account identity", () => {
  const onMakeDefault = vi.fn();
  const onReconnect = vi.fn();
  const onRevoke = vi.fn();
  const account = { ...shared, ownership: "personal", ownerUserId: "alice", isDefault: true, accountLabel: "User account: Connected" } as const;
  flushSync(() => root.render(<AiConnectionAccountControls
    account={account} grant={{ capabilities: {} } as ConnectionGrant} currentUserId="alice"
    onMakeDefault={onMakeDefault} onReconnect={onReconnect} onRevoke={onRevoke}
  />));
  for (const [locale, description] of [
    ["ru", "Личное подключение по умолчанию"], ["en", "Personal default"],
  ]) {
    flushSync(() => { void i18n.changeLanguage(locale); });
    expect(host.textContent).toContain(description);
    expect(host.textContent).toContain("User account: Connected");
    expect(onMakeDefault).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onRevoke).not.toHaveBeenCalled();
  }
  expect(account.id).toBe(shared.id);
  expect(account.grantId).toBe(shared.grantId);
});

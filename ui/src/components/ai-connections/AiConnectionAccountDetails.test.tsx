// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiConnectionAccountIdentity, AiManagedConnectionSummary, ConnectionGrant, ToolConnection } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { AiConnectionAccountDetails } from "./AiConnectionAccountDetails";
import { ManagedAiConnectionDetails } from "./ManagedAiConnectionDetails";

vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));

const account: AiManagedConnectionSummary = {
  id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
  name: "Saved Claude", ownership: "personal", ownerName: "Sam", ownerUserId: "user", isDefault: true, status: "connected",
};
const grant = { id: account.grantId, updatedAt: new Date("2020-01-01T00:00:00.000Z"), capabilities: { canRevoke: true, canEditAudience: false } } as ConnectionGrant;
const known: AiConnectionAccountIdentity = { connectionId: account.id, grantId: grant.id, status: "available", accountLabel: "avery@example.test", organizationLabel: "Example team", checkedAt: "2020-01-01T00:00:00.000Z" };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
let observation: AiConnectionAccountIdentity;
let blocked: boolean;
let signals: AbortSignal[];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  observation = known;
  blocked = false;
  signals = [];
  fetchMock.mockReset().mockImplementation((url: string, init: RequestInit) => {
    if (url.includes("/identity?")) {
      if (blocked) {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      }
      return Promise.resolve(Response.json(observation));
    }
    if (url.endsWith("/active-runs")) return Promise.resolve(Response.json([]));
    if (url.endsWith("/grants")) return Promise.resolve(Response.json({ currentUserId: "user", grants: [grant] }));
    return Promise.resolve(Response.json({ currentUserId: "user", connections: [account], pools: [], canManageConnections: true }));
  });
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await i18n.changeLanguage("en"); });
  client.clear();
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(value = account, selectedGrant = grant, completePanel = false) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{completePanel
      ? <ManagedAiConnectionDetails connection={{ id: value.id, companyId: value.companyId } as ToolConnection} />
      : <AiConnectionAccountDetails account={value} grant={selectedGrant} />}</QueryClientProvider>);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}
const identityCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes("/identity?"));

it("shows the provider email and organization separately from the Paperclip owner", async () => {
  await render();
  expect(host.textContent).toContain("avery@example.test");
  expect(host.textContent).toContain("Example team");
  expect(host.textContent).toContain("Personal · Sam");
  expect(identityCalls()[0][0]).toBe("/api/companies/company/ai-connections/connection/identity?grantId=grant");
});

it("explains profile permission denial while preserving connected account controls", async () => {
  observation = { ...known, status: "unavailable", accountLabel: null, organizationLabel: null, errorCode: "permission_denied", message: "Anthropic did not permit this connection to read the account email." };
  await render(account, grant, true);
  expect(host.textContent).toContain("Personal default");
  expect(host.textContent).toContain("Reconnect");
  expect(host.textContent).toContain("did not permit");
  expect(host.textContent).not.toContain("avery@example.test");
  expect(host.textContent).not.toContain("Retry account check");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(identityCalls()).toHaveLength(1);
});

it("keeps maintenance controls visible during a stalled lookup and recovers only the identity request", async () => {
  blocked = true;
  await render(account, grant, true);
  expect(host.textContent).toContain("Personal default");
  expect(host.textContent).toContain("Reconnect");
  expect(host.textContent).toContain("Checking account details…");
  await act(async () => { await vi.advanceTimersByTimeAsync(20_001); });
  expect(signals[0].aborted).toBe(true);
  expect(host.textContent).toContain("Personal default");
  expect(host.textContent).not.toContain("Checking account details…");
  const ordinaryCalls = fetchMock.mock.calls.length - identityCalls().length;
  blocked = false;
  await act(async () => {
    [...host.querySelectorAll("button")].find(button => button.textContent === "Retry account check")!.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(host.textContent).toContain("avery@example.test");
  expect(fetchMock.mock.calls.length - identityCalls().length).toBe(ordinaryCalls);
});

it("does not show the previous credential's identity after the selected grant changes", async () => {
  await render();
  expect(host.textContent).toContain("avery@example.test");
  blocked = true;
  await render({ ...account, grantId: "other-grant" }, { ...grant, id: "other-grant" });
  expect(host.textContent).not.toContain("avery@example.test");
  expect(host.textContent).toContain("Checking account details…");
});

it("uses saved labels for unsupported methods without opening an identity request", async () => {
  await render({ ...account, method: "api_key", accountLabel: "billing@example.test", ownership: "shared" });
  expect(host.textContent).toContain("billing@example.test");
  expect(host.textContent).toContain("Company shared");
  expect(identityCalls()).toHaveLength(0);
});

it("reuses recent identity observations and invalidates them after reconnect", async () => {
  await render();
  await act(async () => { root.render(null); });
  await render();
  expect(identityCalls()).toHaveLength(1);
  observation = { ...known, accountLabel: "new-account@example.test" };
  await render(account, { ...grant, updatedAt: new Date("2020-01-02T00:00:00.000Z") });
  expect(identityCalls()).toHaveLength(2);
  expect(host.textContent).toContain("new-account@example.test");
  expect(host.textContent).not.toContain("avery@example.test");
});

it("updates mounted account labels without refetching or changing provider and owner identities", async () => {
  const before = JSON.stringify([account, grant, observation]);
  await render();
  const section = host.querySelector("section")!;
  const details = host.querySelector("dl")!;
  const calls = fetchMock.mock.calls.length;
  for (const [locale, heading, provider, organization, method, access, owner] of [
    ["en", "Connected account", "Claude account", "Organization", "Sign-in method", "Access", "Personal · Sam"],
    ["ru", "Подключённый аккаунт", "Учётная запись Claude", "Организация", "Способ входа", "Доступ", "Личное · Sam"],
    ["en", "Connected account", "Claude account", "Organization", "Sign-in method", "Access", "Personal · Sam"],
  ] as const) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.querySelector("section")).toBe(section);
    expect(host.querySelector("dl")).toBe(details);
    expect(section.getAttribute("aria-label")).toBe(heading);
    expect(section.querySelector("h3")?.textContent).toBe(heading);
    expect([...details.querySelectorAll("dt")].map(label => label.textContent)).toEqual([provider, organization, method, access]);
    expect(section.textContent).toContain(owner);
    expect(section.textContent).toContain("avery@example.test");
    expect(section.textContent).toContain("Example team");
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify([account, grant, observation])).toBe(before);
  }
});

it("retranslates a pending account check without restarting or aborting it", async () => {
  blocked = true;
  await render();
  const status = host.querySelector('[role="status"]')!;
  for (const [locale, text] of [
    ["en", "Checking account details…"],
    ["ru", "Проверяем данные учётной записи…"],
    ["en", "Checking account details…"],
  ] as const) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(status.textContent).toBe(text);
    expect(identityCalls()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
  }
});

it.each([
  ["unsupported", "Account details are not available for this sign-in method.", "Для этого способа входа данные учётной записи недоступны."],
  ["connection_unavailable", "Reconnect or enable this connection to check its account details.", "Повторно подключите или включите это подключение, чтобы проверить данные учётной записи."],
  ["authentication_required", "Reconnect this account to check its account details.", "Подключите эту учётную запись повторно, чтобы проверить её данные."],
  ["permission_denied", "Anthropic did not permit this connection to read the account email.", "Anthropic не предоставил этому подключению доступ к адресу электронной почты учётной записи."],
  ["rate_limited", "Anthropic limited this account check. Try again later.", "Anthropic ограничил проверку этой учётной записи. Повторите попытку позже."],
  ["provider_unavailable", "Could not read the account details. Try again later.", "Не удалось получить данные учётной записи. Повторите попытку позже."],
  ["invalid_response", "Anthropic did not return an account email.", "Anthropic не вернул адрес электронной почты учётной записи."],
] as const)("retranslates only the canonical %s notice without another identity request", async (errorCode, message, russian) => {
  observation = { ...known, status: errorCode === "rate_limited" || errorCode === "provider_unavailable" ? "error" : "unavailable", errorCode, message };
  const before = JSON.stringify(observation);
  await render();
  const notice = host.querySelector("p")!;
  const button = host.querySelector("button");
  for (const [locale, text, retry] of [["en", message, "Retry account check"], ["ru", russian, "Повторить проверку учётной записи"], ["en", message, "Retry account check"]] as const) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.querySelector("p")).toBe(notice);
    expect(notice.textContent).toBe(text);
    expect(host.querySelector("button")).toBe(button);
    if (observation.status === "error") expect(button?.textContent).toBe(retry);
    else expect(button).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observation)).toBe(before);
  }
});

it.each([
  ["rate_limited", "RAW_CUSTOM_PROVIDER_DIAGNOSTIC"],
  ["future_provider_status", "Anthropic limited this account check. Try again later."],
  [undefined, "Anthropic limited this account check. Try again later."],
  ["toString", "RAW_PROTOTYPE_NAMED_STATUS"],
  ["permission_denied", "Anthropic limited this account check. Try again later."],
] as const)("preserves unmatched notice %s and its account labels across locale changes", async (errorCode, message) => {
  observation = { ...known, status: "error", errorCode: errorCode as AiConnectionAccountIdentity["errorCode"], message };
  const before = JSON.stringify(observation);
  await render();
  const notice = host.querySelector('[role="alert"]');
  for (const locale of ["en", "ru", "en"]) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.querySelector('[role="alert"]')).toBe(notice);
    expect(notice?.textContent).toBe(message);
    expect(host.textContent).toContain("avery@example.test");
    expect(host.textContent).toContain("Example team");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observation)).toBe(before);
  }
});

it.each(["personal", "shared"] as const)("translates missing identity labels for %s accounts without making an unsupported request", async ownership => {
  const saved: AiManagedConnectionSummary = { ...account, method: "api_key", ownership, ownerName: undefined };
  const before = JSON.stringify(saved);
  await render(saved);
  for (const [locale, missing, access] of [
    ["en", "Not available", ownership === "shared" ? "Company shared" : "Personal · Account owner"],
    ["ru", "Недоступно", ownership === "shared" ? "Общее для организации" : "Личное · Владелец аккаунта"],
    ["en", "Not available", ownership === "shared" ? "Company shared" : "Personal · Account owner"],
  ] as const) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(host.textContent).toContain(missing);
    expect(host.textContent).toContain(access);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(saved)).toBe(before);
  }
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { aiConnectionRouterAppDefinition, type ToolConnection } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { AiConnectionPoolConnector } from "./AiConnectionPoolConnector";

const mocks = vi.hoisted(() => ({ accounts: vi.fn(), pools: vi.fn(), gallery: vi.fn(), agents: vi.fn(), inspect: vi.fn(), save: vi.fn(), remove: vi.fn(), navigate: vi.fn(), breadcrumbs: vi.fn(), toast: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: mocks.accounts } }));
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: mocks.pools, inspect: mocks.inspect, save: mocks.save, remove: mocks.remove } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listGallery: mocks.gallery } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.toast }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => mocks.navigate, Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
vi.mock("@/pages/apps/AppDetail", () => ({ AppDetailHeader: ({ appName }: { appName: string }) => <h1>{appName}</h1> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let client: QueryClient | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear(); container?.remove(); vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

it("keeps an open pool picker and unsaved membership through EN/RU/EN without requests or writes", async () => {
  await i18n.changeLanguage("en");
  const accounts = [
    { id: "account-a", grantId: "grant-a", name: "Customer account A", provider: "openai", method: "api_key", ownership: "shared", status: "connected" },
    { id: "account-b", grantId: "grant-b", name: "Customer account B", provider: "openai", method: "api_key", ownership: "shared", status: "connected" },
  ];
  const member = { id: "member-a", binding: { mode: "shared", provider: "openai", method: "api_key", connectionId: "account-a", grantId: "grant-a" }, profile: { provider: "codex", model: "custom/model" } };
  const pool = { id: "pool", pluginKey: "router", revision: 4, name: "Customer pool", enabled: true, members: [member], mode: "round_robin", thresholdPercent: 90 };
  const original = JSON.stringify({ accounts, pool });
  mocks.accounts.mockResolvedValue({ canManageConnections: true, connections: accounts });
  mocks.pools.mockResolvedValue([pool]);
  mocks.gallery.mockResolvedValue({ apps: [aiConnectionRouterAppDefinition("router", { name: "AI connection pool", description: "Pool" })] });
  mocks.agents.mockResolvedValue([]); mocks.inspect.mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<QueryClientProvider client={client!}><AiConnectionPoolConnector pluginKey="router" connection={{ id: "pool", name: "Customer pool" } as ToolConnection} /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const add = Array.from(container.querySelectorAll("button")).find(button => button.textContent === i18n.t("oct6Beta.copy054"))!;
  expect(add).toBeDefined();
  await act(async () => add.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const checkbox = dialog.querySelector<HTMLElement>('[role="checkbox"][aria-label="Customer account B"]')!;
  await act(async () => checkbox.click());
  for (const locale of ["en", "ru", "en"]) {
    await act(async () => { await i18n.changeLanguage(locale); });
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('[role="checkbox"][aria-label="Customer account B"]')).toBe(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain(locale === "ru" ? "Готово" : "Done");
    expect(dialog.textContent).toContain(locale === "ru" ? "Общий" : "Shared");
    expect(mocks.accounts).toHaveBeenCalledOnce(); expect(mocks.pools).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    expect(JSON.stringify({ accounts, pool })).toBe(original);
  }
  const done = Array.from(dialog.querySelectorAll("button")).find(button => button.textContent === "Done")!;
  await act(async () => done.click());
  expect(container.textContent).toContain("Customer account B");
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
});

// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, type AiConnectionPool, type AiManagedConnectionSummary, type ToolConnection } from "@paperclipai/shared";
import { AiConnectionPoolConnector } from "./AiConnectionPoolConnector";

const mocks = vi.hoisted(() => ({ listAccounts: vi.fn(), listPools: vi.fn(), save: vi.fn(), inspect: vi.fn(), gallery: vi.fn(), agents: vi.fn(), navigate: vi.fn(), toast: vi.fn(), breadcrumbs: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: mocks.listAccounts } }));
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: mocks.listPools, save: mocks.save, inspect: mocks.inspect } }));
vi.mock("@/api/tools", () => ({ toolsApi: { listGallery: mocks.gallery } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.toast }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => mocks.navigate, Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));
vi.mock("@/pages/apps/AppDetail", () => ({ AppDetailHeader: () => <h1>Backup pool</h1> }));
vi.mock("./AiConnectionUsagePanel", () => ({ AiConnectionUsagePanel: () => null }));

const container = document.createElement("div");
const root = createRoot(container);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => { flushSync(() => root.render(null)); client.clear(); container.remove(); });
async function settle() { for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); } }

it("reorders mixed provider backups and saves each account's own model profile", async () => {
  const accounts = [
    { id: "claude", grantId: "claude-grant", name: "Claude primary", provider: "anthropic", method: "subscription", ownership: "shared", status: "connected" },
    { id: "codex", grantId: "codex-grant", name: "Codex backup", provider: "openai", method: "subscription", ownership: "shared", status: "connected" },
  ] as AiManagedConnectionSummary[];
  const pool: AiConnectionPool = { id: "pool", companyId: "company", pluginKey: BUILTIN_AI_FAILOVER_ROUTER_KEY, revision: 1, name: "Backup pool", enabled: true, mode: "failover", thresholdPercent: 90,
    members: accounts.map((account, index) => ({ id: account.id, binding: { mode: "shared", provider: account.provider, method: account.method, connectionId: account.id, grantId: account.grantId },
      profile: index ? { provider: "codex", model: "gpt-5.6-sol", effort: "high" } : { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" } })) };
  mocks.listAccounts.mockResolvedValue({ connections: accounts, canManageConnections: true });
  mocks.listPools.mockResolvedValue([pool]);
  mocks.inspect.mockResolvedValue({});
  mocks.gallery.mockResolvedValue({ apps: [{ aiConnectionRouter: { pluginKey: pool.pluginKey }, name: "Backup pool", branding: { logoUrl: "/pool.svg" } }] });
  mocks.agents.mockResolvedValue([]);
  mocks.save.mockResolvedValue({ ...pool, revision: 2 });
  document.body.append(container);
  flushSync(() => root.render(<QueryClientProvider client={client}><AiConnectionPoolConnector pluginKey={pool.pluginKey} connection={{ id: pool.id } as ToolConnection} /></QueryClientProvider>));
  await settle();
  const names = () => [...container.querySelectorAll('ol[aria-label="Connection order"] li p:first-child')].map(node => node.textContent);
  expect(names()).toEqual(["Claude primary", "Codex backup"]);
  expect(container.textContent).toContain("Mix providers in backup order");
  expect(container.textContent).not.toContain("only Claude accounts");
  flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Move Codex backup up"]')!.click());
  expect(names()).toEqual(["Codex backup", "Claude primary"]);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Model for connection 1"]')?.value).toBe("gpt-5.6-sol");
  const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Save changes")!;
  flushSync(() => save.click());
  await settle();
  expect(mocks.save).toHaveBeenCalledWith("company", expect.objectContaining({ config: expect.objectContaining({ members: [pool.members[1], pool.members[0]] }) }));
});

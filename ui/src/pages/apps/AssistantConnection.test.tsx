// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantConnection, AssistantConnectionCard } from "./AssistantConnection";
const mocks = vi.hoisted(() => ({ setup: vi.fn(), connections: vi.fn(), revoke: vi.fn(), breadcrumbs: vi.fn(), copy: vi.fn() }));
vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/api/publicMcp", () => ({ publicMcpApi: mocks }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "butter", selectedCompany: { id: "butter", name: "Butter", logoUrl: null } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/lib/router", () => ({ Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => <a href={to} {...props}>{children}</a> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const grant = { id: "grant", companyId: "butter", companyName: "Butter", clientName: "OpenCode", scopes: ["paperclip:read", "paperclip:write"], createdAt: "2026-10-05T00:00:00Z", revokedAt: null };
let root: Root, container: HTMLDivElement, client: QueryClient;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function render(element: React.ReactNode = <AssistantConnection initialAssistant="opencode" />) {
  await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  await flush();
}
beforeEach(() => {
  mocks.setup.mockResolvedValue({ enabled: true, serverUrl: "https://canonical.example/mcp/paperclip" });
  mocks.connections.mockResolvedValue([]);
  mocks.revoke.mockResolvedValue(undefined);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });
describe("assistant setup from Connections", () => {
  it("copies a scoped instruction link with no credential and keeps manual configuration collapsed", async () => {
    await render();
    expect(container.querySelector("details")?.open).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy invitation"]')!.click());
    expect(mocks.copy).toHaveBeenLastCalledWith(expect.stringContaining("https://canonical.example/mcp/setup?company=butter"));
    expect(mocks.copy).toHaveBeenLastCalledWith(expect.stringContaining("after I approve"));
    expect(document.body.textContent).toContain("Copied to clipboard");
    expect(container.textContent).not.toContain("Copy link");
    expect(container.textContent).not.toContain("Open setup instructions");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("surfaces catalog status failures and recovers without claiming there are no connections", async () => {
    mocks.connections.mockRejectedValue(new Error("offline"));
    await render(<AssistantConnectionCard onNavigate={vi.fn()} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load your connection status");
    expect(container.querySelector('[aria-label="Set up Assistant Connection (MCP)"]')).toBeNull();
    expect(container.querySelector('[data-connected]')).toBeNull();
    mocks.connections.mockResolvedValue([grant]);
    await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Try again")!.click());
    await flush();
    expect(container.querySelector('[aria-label="Manage Assistant Connection (MCP)"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("uses the canonical URL and explains how OpenCode opens consent without granting access", async () => {
    await render();
    const config = Array.from(container.querySelectorAll("pre")).map(p => p.textContent!).find(p => p.startsWith("{"))!;
    expect(JSON.parse(config).mcp.paperclip).toEqual({ type: "remote", url: "https://canonical.example/mcp/paperclip", enabled: true, oauth: { scope: "paperclip:read paperclip:write paperclip:configure offline_access" } });
    expect(container.textContent).toContain("opencode mcp auth paperclip");
    expect(container.textContent).toContain("No assistants connected to Butter yet");
    expect(container.querySelector('[role="combobox"]')).toBeNull();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("shows the enable path while disabled, with no usable setup instructions", async () => {
    mocks.setup.mockResolvedValue({ enabled: false, serverUrl: "https://canonical.example/mcp/paperclip" });
    await render();
    expect(container.querySelector('a[href="/company/settings/instance/experimental"]')).not.toBeNull();
    expect(container.textContent).not.toContain("opencode mcp auth");
    expect(container.textContent).not.toContain("https://canonical.example");
  });
  it("only shows this organization’s grants and revokes the selected grant", async () => {
    mocks.connections.mockResolvedValue([grant, { ...grant, id: "other", companyId: "elsewhere", clientName: "Other secret client" }]);
    await render();
    expect(container.textContent).not.toContain("Other secret client");
    expect(container.textContent).toContain("Connected as you · Read and write");
    mocks.connections.mockResolvedValue([{ ...grant, revokedAt: "2026-10-05T00:00:00Z" }]);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Revoke OpenCode connection"]')!.click());
    await flush();
    expect(mocks.revoke.mock.calls[0]?.[0]).toBe("grant");
    expect(container.textContent).toContain("Revoked");
    expect(container.querySelector('[aria-label="Copy first prompt"]')).toBeNull();
  });
  it("shows a real grant when the list refreshes after assistant sign-in", async () => {
    await render();
    mocks.connections.mockResolvedValue([grant]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["mcp-connections"] }); });
    await flush();
    expect(container.textContent).toContain("Connected as you · Read and write");
    expect(container.querySelector('[aria-label="Copy first prompt"]')).toBeNull();
  });
  it("shows a recoverable error instead of pretending setup succeeded", async () => {
    mocks.setup.mockRejectedValue(new Error("offline"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load assistant setup");
    mocks.setup.mockResolvedValue({ enabled: true, serverUrl: "https://canonical.example/mcp/paperclip" });
    await act(async () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === "Try again")!.click());
    await flush();
    expect(container.textContent).toContain("opencode mcp auth paperclip");
  });
});

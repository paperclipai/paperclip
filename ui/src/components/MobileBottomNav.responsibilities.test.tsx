// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

const fixture = vi.hoisted(() => ({ coordinator: false, responsibilities: false }));

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: fixture.coordinator }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: false }) }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("@/hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0 }) }));
vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({ useCoordinatorAttentionCount: () => 0 }));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: async () => ({ enableResponsibilities: fixture.responsibilities }) },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/issues" }),
  NavLink: ({ to, children }: { to: string; children: (state: { isActive: boolean }) => ReactNode }) => (
    <a href={to}>{children({ isActive: false })}</a>
  ),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function renderNav() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<QueryClientProvider client={client}><MobileBottomNav visible /></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); });
  cleanup = async () => {
    await act(() => root.unmount());
    host.remove();
    client.clear();
  };
  return host;
}

const tabs = (host: HTMLElement) =>
  [...host.querySelectorAll("a, button")].map((node) => `${node.textContent}:${node.getAttribute("href") ?? "action"}`);

it.each([
  [false, "/dashboard"],
  [true, "/responsibilities"],
])("points Home at the company home in the classic bar (Responsibilities %s)", async (enabled, home) => {
  fixture.coordinator = false;
  fixture.responsibilities = enabled;
  const host = await renderNav();
  expect(tabs(host)[0]).toBe(`Home:${home}`);
});

it("adds a Home tab for Responsibilities to the coordinator bar only while the flag is on", async () => {
  fixture.coordinator = true;
  fixture.responsibilities = true;
  let host = await renderNav();
  expect(tabs(host)).toEqual(["Home:/responsibilities", "Chat:/chats", "Tasks:/issues", "Inbox:/decisions", "New task:action"]);
  await cleanup?.();

  fixture.responsibilities = false;
  host = await renderNav();
  expect(tabs(host)).toEqual(["Chat:/chats", "Tasks:/issues", "Inbox:/decisions", "New task:action"]);
});

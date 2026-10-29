// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";
import { coordinatorAttentionQueryKey } from "@/lib/coordinator-attention";

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useCombinedInboxTasksEnabled", () => ({ useCombinedInboxTasksEnabled: () => ({ enabled: false }) }));
vi.mock("@/hooks/useInboxBadge", () => ({ useInboxBadge: () => ({ inbox: 0 }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: "/chats" }), NavLink: ({ to, children }: { to: string; children: (state: { isActive: boolean }) => ReactNode }) => <a href={to}>{children({ isActive: false })}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("uses the canonical outstanding count on the phone as well as the desktop", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const key = coordinatorAttentionQueryKey("company");
  client.setQueryData(key, { totalCount: 3, deskBadgeCount: 0 });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(() => root.render(<QueryClientProvider client={client}><MobileBottomNav visible /></QueryClientProvider>));
    expect(host.querySelector('a[href="/decisions"]')?.textContent).toBe("3Needs You");
    await act(async () => { client.setQueryData(key, { totalCount: 0, deskBadgeCount: 0 }); await new Promise(resolve => setTimeout(resolve, 1)); });
    expect(host.querySelector('a[href="/decisions"]')?.textContent).toBe("Needs You");
  } finally { await act(() => root.unmount()); host.remove(); client.clear(); }
});

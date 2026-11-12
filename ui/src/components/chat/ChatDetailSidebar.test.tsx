// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChatDetailSidebar } from "./ChatDetailSidebar";
import { ChatSetupSidebar } from "./ChatSetupNavigation";
import { githubChatApi } from "@/api/githubChat";
import { queryKeys } from "@/lib/queryKeys";
const setup = vi.hoisted(() => ({ params: "provider=github&resume=endpoint-a", advance: vi.fn() }));
vi.mock("@/api/githubChat", () => ({ githubChatApi: { advance: setup.advance } }));
import { SidebarNavItem, SidebarNavExpandedProvider } from "../SidebarNavItem";
import { SidebarNavItem as ProductionNavItem, SidebarNavExpandedProvider as ProductionProvider } from "../SidebarNavItem.production";
import { TooltipProvider } from "../ui/tooltip";

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ collapsed: true, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  useSearchParams: () => [new URLSearchParams(setup.params)],
  NavLink: ({ to, children, className }: { to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string) }) =>
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className}>{children}</a>,
}));

describe("chat detail sidebar with collapsed global navigation", () => {
  it.each([
    ["default", SidebarNavExpandedProvider, SidebarNavItem],
    ["production", ProductionProvider, ProductionNavItem],
  ] as const)("keeps labels visible in the %s layout", (_name, Provider, NavItem) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<QueryClientProvider client={queryClient}><TooltipProvider><Provider><ChatDetailSidebar endpointId="endpoint-a" NavItem={NavItem} /></Provider></TooltipProvider></QueryClientProvider>));
      for (const label of ["Settings", "Access", "Conversations", "Activity"]) {
        const span = Array.from(container.querySelectorAll("span")).find((node) => node.textContent === label);
        expect(span?.classList.contains("truncate")).toBe(true);
      }
    } finally { flushSync(() => root.unmount()); }
  });
});

describe("completed GitHub setup navigation", () => {
  it.each([
    ["provider=github&resume=endpoint-a", true],
    ["provider=github&resume=endpoint-a&reconnect=1", false],
    ["provider=github&resume=endpoint-a&stage=identity", false],
  ])("uses the right sidebar for %s without advancing setup", (params, complete) => {
    setup.params = params;
    setup.advance.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    client.setQueryData(["github-wizard", "endpoint-a"], { endpointId: "endpoint-a", state: "connected" });
    client.setQueryData(queryKeys.chatEndpoints.detail("endpoint-a"), { provider: "github" });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<QueryClientProvider client={client}><TooltipProvider><SidebarNavExpandedProvider>
        <ChatSetupSidebar />
      </SidebarNavExpandedProvider></TooltipProvider></QueryClientProvider>));
      expect(container.querySelector('nav[aria-label="Chat connection"]') !== null).toBe(complete);
      if (complete) {
        expect(container.textContent).toContain("Settings");
        expect(container.textContent).toContain("Reviews");
      }
      expect(githubChatApi.advance).not.toHaveBeenCalled();
    } finally { flushSync(() => root.unmount()); client.clear(); }
  });
});

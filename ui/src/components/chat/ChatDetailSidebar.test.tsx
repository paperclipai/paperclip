// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChatDetailSidebar } from "./ChatDetailSidebar";
import { SidebarNavItem, SidebarNavExpandedProvider } from "../SidebarNavItem";
import { SidebarNavItem as ProductionNavItem, SidebarNavExpandedProvider as ProductionProvider } from "../SidebarNavItem.production";
import { TooltipProvider } from "../ui/tooltip";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ collapsed: true, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }),
}));
vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className }: { to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string) }) =>
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className}>{children}</a>,
}));

describe("chat detail sidebar with collapsed global navigation", () => {
  it.each([
    ["default", SidebarNavExpandedProvider, SidebarNavItem],
    ["production", ProductionProvider, ProductionNavItem],
  ] as const)("keeps localized labels and routes stable in the %s layout", async (_name, Provider, NavItem) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    queryClient.setQueryData(queryKeys.chatEndpoints.detail("endpoint-a"), { provider: "github" });
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<QueryClientProvider client={queryClient}><TooltipProvider><Provider><ChatDetailSidebar endpointId="endpoint-a" NavItem={NavItem} /></Provider></TooltipProvider></QueryClientProvider>));
      const links = Array.from(container.querySelectorAll("a"));
      const hrefs = links.map((link) => link.getAttribute("href"));
      expect(hrefs).toEqual(["settings", "access", "reviews", "conversations", "activity"].map((path) => `/apps/chat/endpoint-a/${path}`));
      for (const language of ["ru", "en", "ru"]) {
        await act(async () => { await i18n.changeLanguage(language); });
        const labels = language === "ru"
          ? ["Настройки", "Доступ", "Ревью", "Беседы", "Активность"]
          : ["Settings", "Access", "Reviews", "Conversations", "Activity"];
        for (const label of labels) {
          const span = Array.from(container.querySelectorAll("span")).find((node) => node.textContent === label);
          expect(span?.classList.contains("truncate")).toBe(true);
        }
        expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe(language === "ru" ? "Подключение чата" : "Chat connection");
        Array.from(container.querySelectorAll("a")).forEach((link, index) => {
          expect(link).toBe(links[index]);
          expect(link.getAttribute("href")).toBe(hrefs[index]);
        });
      }
    } finally {
      flushSync(() => root.unmount());
      queryClient.clear();
      await act(async () => { await i18n.changeLanguage("en"); });
    }
  });
});

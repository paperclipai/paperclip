// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { AgentChatSidebar } from "./AgentChatSidebar";

vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/components/SidebarSection", () => ({ SidebarSection: ({ label, children, collapsible }: { label: string; children: ReactNode; collapsible: { open: boolean; onOpenChange: (open: boolean) => void } }) => <section><button aria-expanded={collapsible.open} onClick={() => collapsible.onOpenChange(!collapsible.open)}>{label}</button>{collapsible.open ? children : null}</section> }));
vi.mock("@/components/SidebarNavItem", () => ({ SidebarNavItem: ({ to, label }: { to: string; label: string }) => <a href={to}>{label}</a> }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));

afterEach(async () => { await i18n.changeLanguage("en"); });

it("retranslates pin controls without changing identities, selection or collapse state", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), toggle = vi.fn();
  const agent = { id: "raw-agent", name: "Board", companyId: "raw-company", icon: null } as Agent;
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(<AgentChatSidebar agents={[agent]} activeId={agent.id} starredIds={[agent.id]} recentIds={[]} href={() => "/chats/raw-agent"} onToggleStar={toggle} />);
    });
    const star = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector('[aria-pressed="true"]')).toBe(star);
      expect(star.getAttribute("aria-label")).toBe(language === "ru" ? "Убрать из избранного: Board" : "Unstar Board");
      expect(host.querySelector('a[href="/chats/raw-agent"]')?.textContent).toBe("Board");
      expect(toggle).not.toHaveBeenCalled();
    }
    await act(async () => star.click());
    expect(toggle).toHaveBeenCalledExactlyOnceWith("raw-agent");
    const section = host.querySelector<HTMLButtonElement>("[aria-expanded]")!;
    await act(async () => section.click());
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(section.getAttribute("aria-expanded")).toBe("false");
    expect(section.textContent).toBe("Агенты");
    expect(host.querySelector("a")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { AgentChatSidebar } from "./AgentChatSidebar";

vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/components/SidebarNavItem", () => ({ SidebarNavItem: ({ to, label }: { to: string; label: string }) => <a href={to}>{label}</a> }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));

afterEach(async () => { await i18n.changeLanguage("en"); });

it("retranslates pin and compose controls without changing identities or selection", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), toggle = vi.fn(), openChat = vi.fn();
  const agent = { id: "raw-agent", name: "Board", companyId: "raw-company", icon: null } as Agent;
  try {
    await act(async () => {
      await i18n.changeLanguage("en");
      root.render(<AgentChatSidebar agents={[agent]} activeId={agent.id} starredIds={[agent.id]} recentIds={[]} href={() => "/chats/raw-agent"} onToggleStar={toggle} onOpenChat={openChat} />);
    });
    const star = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector('[aria-pressed="true"]')).toBe(star);
      expect(star.getAttribute("aria-label")).toBe(language === "ru" ? "Убрать из избранного: Board" : "Unstar Board");
      expect(host.querySelector('a[href="/chats/raw-agent"]')?.textContent).toBe("Board");
      expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(language === "ru" ? "Чаты" : "Chats");
      expect(host.querySelector<HTMLButtonElement>('button:not([aria-pressed])')?.getAttribute("aria-label")).toBe(language === "ru" ? "Чат с агентом" : "Chat with an agent");
      expect(toggle).not.toHaveBeenCalled();
      expect(openChat).not.toHaveBeenCalled();
    }
    await act(async () => star.click());
    expect(toggle).toHaveBeenCalledExactlyOnceWith("raw-agent");
    await act(async () => host.querySelector<HTMLButtonElement>('button:not([aria-pressed])')!.click());
    expect(openChat).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

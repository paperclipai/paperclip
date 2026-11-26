// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentContextualMobileNav } from "./AgentContextualSidebar";
import { AppDetailMobileNav } from "./AppConnectionSidebar";
import { AppsMobileNav } from "./AppsSidebar";
import { ChatDetailMobileNav } from "./chat/ChatDetailSidebar";
import { AgentConversationSidebar } from "./AgentConversationSidebar";
import { MobileContextualNav } from "./MobileContextualNav";
import { queryKeys } from "@/lib/queryKeys";

const mockUsePluginSlots = vi.fn();
const mockUseAgentEnvironmentSlots = vi.fn();
const mockUseSmokeLabEnabled = vi.fn();

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: true, sidebarOpen: false, setSidebarOpen: vi.fn(), toggleSidebar: vi.fn() }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: (...args: unknown[]) => mockUsePluginSlots(...args),
}));

vi.mock("@/plugins/useAgentEnvironmentSlots", () => ({
  useAgentEnvironmentSlots: (...args: unknown[]) => mockUseAgentEnvironmentSlots(...args),
}));

vi.mock("@/hooks/useSmokeLabEnabled", () => ({
  useSmokeLabEnabled: () => mockUseSmokeLabEnabled(),
}));

describe("Mobile contextual section switchers", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockUsePluginSlots.mockReturnValue({ slots: [] });
    mockUseAgentEnvironmentSlots.mockImplementation((slots: unknown[]) => ({ slots }));
    mockUseSmokeLabEnabled.mockReturnValue({ enabled: true });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders all 10 built-in Agent Detail views plus plugin detailTab slots inline on mobile", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          id: "memory-tab",
          pluginKey: "paperclip.memory",
          displayName: "Memory",
        },
      ],
    });

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/PAP/agents/codexcoder/overview"]}>
            <Routes>
              <Route
                path="/:companyPrefix/agents/:agentId/:tab"
                element={<AgentContextualMobileNav agentRef="codexcoder" agentId="agent-1" agentName="CodexCoder" />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const nav = container.querySelector('[data-mobile-contextual-nav="agent"]');
    expect(nav).not.toBeNull();
    const links = Array.from(nav!.querySelectorAll("a"));
    const labels = links.map((link) => link.textContent);
    expect(labels).toEqual([
      "Overview",
      "Identity",
      "Harness / Runtime",
      "Secrets & variables",
      "Permissions / Trust",
      "Advanced",
      "Memory",
      "Activity",
      "Runs",
      "Costs",
      "Budgets",
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    expect(links[6]?.getAttribute("href")).toBe("/PAP/agents/codexcoder/plugin%3Apaperclip.memory%3Amemory-tab");
  });

  it("renders AppDetail inline switcher with Permissions and Review tabs plus review badge", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.tools.connection("conn-1"), {
      id: "conn-1",
      name: "GitHub",
      applicationId: "app-1",
      status: "connected",
    });
    queryClient.setQueryData(queryKeys.tools.applications("company-1"), { applications: [] });
    queryClient.setQueryData(queryKeys.apps.gallery("company-1"), { apps: [] });
    queryClient.setQueryData(queryKeys.apps.connectionReviewCounts("company-1", "conn-1"), {
      pendingActionRequestCount: 3,
      quarantinedCatalogEntryCount: 0,
    });

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/PAP/apps/conn-1/permissions"]}>
            <Routes>
              <Route
                path="/:companyPrefix/apps/:connectionId/:tab"
                element={<AppDetailMobileNav kind="connection" connectionId="conn-1" />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const nav = container.querySelector('[data-mobile-contextual-nav="app-detail"]');
    expect(nav).not.toBeNull();
    const links = Array.from(nav!.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/PAP/apps/conn-1/permissions",
      "/PAP/apps/conn-1/review",
    ]);
    expect(links[1]?.textContent).toContain("Review");
    expect(links[1]?.textContent).toContain("3");
  });

  it("renders ChatEndpointDetail inline switcher including GitHub Reviews tab", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.chatEndpoints.detail("ep-1"), {
      id: "ep-1",
      provider: "github",
    });

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/PAP/apps/chat/ep-1/settings"]}>
            <Routes>
              <Route
                path="/:companyPrefix/apps/chat/:endpointId/:tab"
                element={<ChatDetailMobileNav endpointId="ep-1" />}
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const nav = container.querySelector('[data-mobile-contextual-nav="chat-detail"]');
    expect(nav).not.toBeNull();
    const labels = Array.from(nav!.querySelectorAll("a")).map((a) => a.textContent);
    expect(labels).toEqual(["Settings", "Access", "Reviews", "Conversations", "Activity"]);
  });

  it("renders AppsMobileNav developer tabs when smoke lab is enabled", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/PAP/apps/advanced/smoke-lab"]}>
            <Routes>
              <Route path="/:companyPrefix/apps/advanced/:tab" element={<AppsMobileNav />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const nav = container.querySelector('[data-mobile-contextual-nav="apps"]');
    expect(nav).not.toBeNull();
    const labels = Array.from(nav!.querySelectorAll("a")).map((a) => a.textContent);
    expect(labels).toEqual(["All plugins", "Smoke Lab"]);
  });

  it("renders inline mobile switcher trigger for AgentConversationSidebar with active agent and other unread count", () => {
    const agents = [
      { id: "a1", name: "Chief of Staff", role: "ceo", status: "active", companyId: "company-1" },
      { id: "a2", name: "CodexCoder", role: "engineer", status: "active", companyId: "company-1" },
    ] as Parameters<typeof AgentConversationSidebar>[0]["agents"];

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <MemoryRouter initialEntries={["/PAP/chats/chief-of-staff"]}>
          <AgentConversationSidebar
            agents={agents}
            activeId="a1"
            unreadMessageCounts={new Map([["a1", 2], ["a2", 5]])}
            mobileSwitcher
          />
        </MemoryRouter>,
      );
    });

    const trigger = container.querySelector('[data-mobile-contextual-nav="agent-chat"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("Browse chats");
    expect(trigger?.textContent).toContain("Chief of Staff");
    expect(trigger?.textContent).toContain("5");
  });

  it("renders chat history error and retry button in AgentConversationSidebar mobileSwitcher mode", () => {
    const onRetryHistory = vi.fn();
    const agents = [
      { id: "a1", name: "Chief of Staff", role: "ceo", status: "active", companyId: "company-1" },
    ] as Parameters<typeof AgentConversationSidebar>[0]["agents"];

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <MemoryRouter initialEntries={["/PAP/chats/chief-of-staff"]}>
          <AgentConversationSidebar
            agents={agents}
            activeId="a1"
            historyError={new Error("network failed")}
            onRetryHistory={onRetryHistory}
            mobileSwitcher
          />
        </MemoryRouter>,
      );
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Some chat history couldn’t load.");
    const retryBtn = Array.from(alert!.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Retry chat history"),
    ) as HTMLButtonElement;
    expect(retryBtn).toBeDefined();
    flushSync(() => {
      retryBtn.click();
    });
    expect(onRetryHistory).toHaveBeenCalledTimes(1);
  });

  it("scrolls newly loaded active tabs into view when items arrive within an existing group", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <MemoryRouter initialEntries={["/PAP/apps/chat/ep-1/reviews"]}>
          <Routes>
            <Route
              path="/:companyPrefix/apps/chat/:endpointId/:tab"
              element={
                <MobileContextualNav
                  surface="chat-detail"
                  ariaLabel="Chat connection"
                  groups={[
                    {
                      key: "chat-detail",
                      items: [
                        { key: "settings", to: "/apps/chat/ep-1/settings", label: "Settings", end: true },
                      ],
                    },
                  ]}
                />
              }
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    flushSync(() => {
      root!.render(
        <MemoryRouter initialEntries={["/PAP/apps/chat/ep-1/reviews"]}>
          <Routes>
            <Route
              path="/:companyPrefix/apps/chat/:endpointId/:tab"
              element={
                <MobileContextualNav
                  surface="chat-detail"
                  ariaLabel="Chat connection"
                  groups={[
                    {
                      key: "chat-detail",
                      items: [
                        { key: "settings", to: "/apps/chat/ep-1/settings", label: "Settings", end: true },
                        { key: "reviews", to: "/apps/chat/ep-1/reviews", label: "Reviews" },
                      ],
                    },
                  ]}
                />
              }
            />
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ inline: "nearest", block: "nearest" });
  });
});

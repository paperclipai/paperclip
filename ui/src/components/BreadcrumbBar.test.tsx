// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs } from "../context/BreadcrumbContext";
import { i18n } from "@/i18n";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { CoordinatorAgentSwitcher } from "./CoordinatorAgentSwitcher";
import type { Agent } from "@paperclipai/shared";

const viewport = vi.hoisted(() => ({ isMobile: false }));
const navigate = vi.hoisted(() => vi.fn());
const chatAgents = vi.hoisted(() => [
  { id: "first", name: "CodexCoder", role: "engineer", status: "idle" },
  { id: "second", name: "Designer", role: "designer", status: "idle" },
]);

vi.mock("@/hooks/useAgentChatNavigation", () => ({
  useAgentChatNavigation: () => ({
    agents: { data: chatAgents, isPending: false, error: null },
    chats: { data: [] },
  }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, className, to }: { children: ReactNode; className?: string; to: string }) => (
    <a className={className} href={to}>{children}</a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    collapsed: false,
    isMobile: viewport.isMobile,
    toggleCollapsed: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { issuePrefix: "TES" } }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ panelVisible: true, togglePanelVisible: vi.fn() }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [] }),
  PluginSlotOutlet: () => null,
}));

vi.mock("@/plugins/launchers", () => ({
  usePluginLaunchers: () => ({ launchers: [] }),
  PluginLauncherOutlet: () => null,
}));

function TaskBreadcrumbs({
  onOpen,
  panelControl,
  taskDetailLayout = false,
  identifier = "PAP-16679",
  sourceHref = "/issues",
}: {
  onOpen?: () => void;
  panelControl?: { open: boolean; onToggle: () => void };
  taskDetailLayout?: boolean;
  identifier?: string;
  sourceHref?: string;
}) {
  const {
    setBreadcrumbs,
    setBreadcrumbToolbar,
    setBreadcrumbPanelControl,
  } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Tasks", href: sourceHref },
      {
        label: "Hire your first engineer and create a hiring plan",
        identifier,
        leading: "status",
      },
    ]);
    setBreadcrumbToolbar(
      onOpen ? (
        <button type="button" aria-label="Show task side panel" onClick={onOpen}>
          Show panel
        </button>
      ) : null,
    );
    setBreadcrumbPanelControl(panelControl ?? null);
    return () => {
      setBreadcrumbToolbar(null);
      setBreadcrumbPanelControl(null);
    };
  }, [
    identifier,
    onOpen,
    panelControl,
    setBreadcrumbPanelControl,
    setBreadcrumbToolbar,
    setBreadcrumbs,
    sourceHref,
  ]);

  return <BreadcrumbBar taskDetailLayout={taskDetailLayout} />;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BreadcrumbBar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    viewport.isMobile = false;
    navigate.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  it.each(["en", "zh-CN"])("uses the standard Chat heading and localized properties toggle (%s)", async (locale) => {
    await i18n.changeLanguage(locale);
    const toggle = vi.fn();
    function ChatHeader() {
      const { setBreadcrumbs, setBreadcrumbPanelControl } = useBreadcrumbs();
      useEffect(() => {
        setBreadcrumbs([{ label: "Chat" }]);
        setBreadcrumbPanelControl({ open: false, onToggle: toggle });
      }, [setBreadcrumbs, setBreadcrumbPanelControl]);
      return <BreadcrumbBar showPropertiesToggle />;
    }
    await act(async () => root.render(<BreadcrumbProvider><ChatHeader /></BreadcrumbProvider>));
    expect(container.querySelector("h1")?.textContent).toBe("Chat");
    expect(container.querySelector("h1")?.className).toContain("uppercase");
    expect(container.querySelector('[aria-label^="Switch agent"]')).toBeNull();
    expect(container.querySelector('[aria-label^="Pin "]')).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${locale === "en" ? "Show properties" : "显示属性"}"]`)!;
    expect(button.title).toBe(locale === "en" ? "Show properties" : "显示属性");
    await act(async () => button.click());
    expect(toggle).toHaveBeenCalledOnce();
  });

  it.each([
    { mobile: false, taskDetailLayout: true },
    { mobile: true, taskDetailLayout: true },
    { mobile: false, taskDetailLayout: false },
    { mobile: true, taskDetailLayout: false },
  ])("opens the agent picker from the avatar, name and caret (mobile=$mobile, task=$taskDetailLayout)", async ({ mobile, taskDetailLayout }) => {
    viewport.isMobile = mobile;
    const agent = chatAgents[0] as Agent;
    function AgentBreadcrumb() {
      const { setBreadcrumbs } = useBreadcrumbs();
      useEffect(() => {
        setBreadcrumbs([{
          label: agent.name,
          control: <CoordinatorAgentSwitcher agent={agent} />,
          controlKey: agent.id,
        }]);
      }, [setBreadcrumbs]);
      return <BreadcrumbBar taskDetailLayout={taskDetailLayout} />;
    }
    await act(async () => root.render(<BreadcrumbProvider><AgentBreadcrumb /></BreadcrumbProvider>));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Switch agent. Currently CodexCoder"]')!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-current")).toBe("page");
    expect(button.closest('[aria-disabled="true"]')).toBeNull();
    expect(button.querySelector("button, a")).toBeNull();
    expect(document.title).toBe("CodexCoder • Paperclip");
    for (const selector of ['[data-slot="agent-avatar"]', "[data-agent-name]", "svg"]) {
      const target = button.querySelector<HTMLElement>(selector);
      expect(target).not.toBeNull();
      await act(async () => { button.focus(); target!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Chat with an agent");
      expect(button.getAttribute("aria-expanded")).toBe("true");
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(button));
    }
    await act(async () => button.click());
    const next = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes("Designer"))!;
    await act(async () => next.click());
    expect(navigate).toHaveBeenCalledWith("/chats/designer");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a single task breadcrumb compact with adjacent identity and settings action", async () => {
    const configure = vi.fn();
    function AgentBreadcrumb() {
      const { setBreadcrumbs } = useBreadcrumbs();
      useEffect(() => {
        setBreadcrumbs([{
          label: "CodexCoder",
          leading: <span aria-label="Agent avatar">CC</span>,
          leadingKey: "codex-avatar",
          trailing: <button aria-label="Configure CodexCoder" onClick={configure}>Settings</button>,
          trailingKey: "codex-settings",
        }]);
      }, [setBreadcrumbs]);
      return <BreadcrumbBar taskDetailLayout />;
    }
    await act(async () => root.render(<BreadcrumbProvider><AgentBreadcrumb /></BreadcrumbProvider>));
    const label = container.querySelector('[data-slot="breadcrumb-page"]');
    expect(label?.textContent).toBe("CCCodexCoder");
    expect(label?.classList.contains("items-center")).toBe(true);
    expect(label?.classList.contains("items-baseline")).toBe(false);
    expect(container.querySelector("h1")).toBeNull();
    const settings = container.querySelector<HTMLButtonElement>('button[aria-label="Configure CodexCoder"]');
    expect(settings?.closest('[data-slot="breadcrumb-item"]')).toBe(label?.closest('[data-slot="breadcrumb-item"]'));
    expect(settings?.closest('[aria-disabled="true"]')).toBeNull();
    act(() => settings?.click());
    expect(configure).toHaveBeenCalledOnce();
    expect(container.querySelector('button[aria-label="Hide properties"]')).not.toBeNull();
  });

  it("shows only the title followed by its identifier for a company-scoped mobile task header", async () => {
    viewport.isMobile = true;
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <TaskBreadcrumbs identifier="TES-3" sourceHref="/TES/issues" />
        </BreadcrumbProvider>,
      );
    });
    expect(container.querySelector('a[href="/TES/issues"]')).toBeNull();
    const identifier = container.querySelector('[data-slot="task-title-identifier"]');
    expect(identifier?.textContent).toBe("TES-3");
    expect(identifier?.previousElementSibling?.textContent).toBe("Hire your first engineer and create a hiring plan");
    expect(identifier?.previousElementSibling?.className).toContain("truncate");
    expect(container.querySelector('button[aria-label="Open sidebar"]')).not.toBeNull();
  });

  it("renders a page toolbar in the same persistent row as the task breadcrumb", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <TaskBreadcrumbs onOpen={onOpen} />
        </BreadcrumbProvider>,
      );
    });

    const launcher = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show task side panel"]',
    );
    expect(launcher).not.toBeNull();
    expect(launcher?.closest(".h-\\(--sz-60px\\)")?.textContent).toContain("PAP-16679");

    act(() => launcher?.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("appends the task identifier to the task title in the task-detail header", async () => {
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <TaskBreadcrumbs taskDetailLayout identifier="TES-1" />
        </BreadcrumbProvider>,
      );
    });

    const identifier = container.querySelector('[data-slot="task-title-identifier"]');
    expect(identifier).toBeTruthy();
    expect(identifier?.className).not.toContain("absolute");
    expect(identifier?.closest(".relative")?.className).toContain("border-b");
    expect(identifier?.closest(".relative")?.className).toContain("border-border");
    expect(identifier?.closest(".relative")?.className).toContain("h-(--sz-60px)");

    const title = Array.from(container.querySelectorAll("span"))
      .find((element) => element.textContent === "Hire your first engineer and create a hiring plan");
    const tasksLink = container.querySelector<HTMLAnchorElement>('a[href="/issues"]');
    const header = tasksLink?.closest(".relative");
    expect(header?.classList).toContain("px-4");
    expect(header?.classList).toContain("md:px-6");
    expect(header?.classList).not.toContain("px-3");
    expect(tasksLink?.classList).toContain("font-semibold");
    expect(tasksLink?.classList).toContain("tracking-wider");
    expect(tasksLink?.classList).toContain("text-muted-foreground");
    expect(tasksLink?.classList).toContain("hover:text-foreground");
    expect(tasksLink?.classList).not.toContain("font-bold");
    expect(title?.className).toContain("truncate");
    expect(title?.nextElementSibling).toBe(identifier);
    expect(identifier?.textContent).toBe("TES-1");
  });

  it("styles the root crumb as an uppercase muted header on every detail view", async () => {
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <TaskBreadcrumbs />
        </BreadcrumbProvider>,
      );
    });

    const rootCrumb = container.querySelector<HTMLAnchorElement>('a[href="/issues"]');
    expect(rootCrumb?.classList).toContain("font-semibold");
    expect(rootCrumb?.classList).toContain("uppercase");
    expect(rootCrumb?.classList).toContain("tracking-wider");
    expect(rootCrumb?.classList).toContain("text-muted-foreground");
    expect(rootCrumb?.classList).toContain("hover:text-foreground");
  });

  it("routes the single task-detail panel button through a page override", async () => {
    const onToggle = vi.fn();
    const panelControl = { open: false, onToggle };
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <TaskBreadcrumbs taskDetailLayout panelControl={panelControl} />
        </BreadcrumbProvider>,
      );
    });

    const launcher = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show properties"]',
    );
    expect(launcher).not.toBeNull();
    expect(container.querySelector('button[aria-label="Hide properties"]')).toBeNull();

    act(() => launcher?.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("omits the retired sidebar control and keeps the properties control", async () => {
    await act(async () => {
      root.render(
        <BreadcrumbProvider>
          <TaskBreadcrumbs taskDetailLayout />
        </BreadcrumbProvider>,
      );
    });

    const leftControl = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse sidebar"]',
    );
    const rightControl = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide properties"]',
    );

    expect(leftControl).toBeNull();
    expect(container.querySelector('button[aria-label="Expand sidebar"]')).toBeNull();
    expect(rightControl?.className).toContain("size-9");
    expect(rightControl?.className).not.toContain("rounded-none");
    expect(rightControl?.className).not.toContain("h-full");
  });
});

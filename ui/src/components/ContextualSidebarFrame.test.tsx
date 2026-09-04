// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "lucide-react";
import { ContextualSidebarFrame } from "./ContextualSidebarFrame";
import { rememberContextualSidebarOrigin } from "@/lib/shell-navigation";

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({ useNavigate: () => mockNavigate }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { name: "Paperclip", issuePrefix: "PAP" } }),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn(), collapsed: true, peeking: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ContextualSidebarFrame", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  function render() {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ContextualSidebarFrame surface="settings" title="Settings" icon={Settings}>
          <nav>Settings links</nav>
        </ContextualSidebarFrame>,
      );
    });
    return root;
  }

  it("renders the contextual identity and uses a safe fallback", () => {
    const root = render();
    expect(container.textContent).toContain("Paperclip");
    expect(container.textContent).toContain("Settings");

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Back from Settings"]')?.click();
    });
    expect(mockNavigate).toHaveBeenCalledWith("/dashboard");
    act(() => root.unmount());
  });

  it("returns to the same-company route that opened the contextual surface", () => {
    rememberContextualSidebarOrigin({
      surface: "settings",
      companyPrefix: "PAP",
      previousPathname: "/PAP/issues/task-1",
    });
    const root = render();

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Back from Settings"]')?.click();
    });
    expect(mockNavigate).toHaveBeenCalledWith("/PAP/issues/task-1");
    act(() => root.unmount());
  });

  it("can omit contextual identity when the breadcrumb already provides it", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ContextualSidebarFrame surface="skills" title="Skills" showHeader={false}>
          <nav>Skill links</nav>
        </ContextualSidebarFrame>,
      );
    });

    expect(container.textContent).toBe("Skill links");
    expect(container.querySelector('[aria-label="Back from Skills"]')).toBeNull();
    act(() => root.unmount());
  });
});

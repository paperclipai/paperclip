// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useContext, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertiesPanel, PropertiesPanelHostContext } from "./PropertiesPanel";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

const mockPanelState = vi.hoisted(() => ({
  panelContent: null as unknown,
  panelVisible: true,
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    panelContent: mockPanelState.panelContent,
    panelVisible: mockPanelState.panelVisible,
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    setPanelVisible: vi.fn(),
    togglePanelVisible: vi.fn(),
  }),
}));

function PanelHostProbe() {
  const host = useContext(PropertiesPanelHostContext);
  return <div data-panel-host={host ?? "none"} />;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("PropertiesPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderPanel({
    panelVisible = true,
    panelContent = <div data-testid="panel-content">content</div>,
  }: { panelVisible?: boolean; panelContent?: ReactNode } = {}) {
    mockPanelState.panelContent = panelContent;
    mockPanelState.panelVisible = panelVisible;
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <PropertiesPanel />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("uses complementary breakpoints for the mobile sheet and desktop pane", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableClassicTaskInterface: false,
    });
    await renderPanel();

    const mobileSheet = container.querySelector('[aria-label="Close properties panel"]')
      ?.nextElementSibling;
    const desktopPane = container.querySelector("aside");

    expect(mobileSheet).not.toBeNull();
    expect(mobileSheet!.classList.contains("md:hidden")).toBe(true);
    expect(mobileSheet!.classList.contains("lg:hidden")).toBe(false);
    expect(desktopPane!.classList.contains("hidden")).toBe(true);
    expect(desktopPane!.classList.contains("md:flex")).toBe(true);
  });

  describe("classic task interface on (legacy panel)", () => {
    beforeEach(() => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({
        enableClassicTaskInterface: true,
      });
    });

    it("renders the fixed-width panel with no grip and no maximize button", async () => {
      await renderPanel();
      const aside = container.querySelector("aside");
      expect(aside).not.toBeNull();
      expect(aside!.style.width).toBe("320px");
      expect(aside!.querySelector('[role="separator"]')).toBeNull();
      expect(container.querySelector('[aria-label="Maximize panel"]')).toBeNull();
      // Inner wrapper keeps the hardcoded width classes exactly as today.
      expect(aside!.querySelector(".w-80")).not.toBeNull();
    });

    it("collapses to width 0 when the panel is hidden", async () => {
      await renderPanel({ panelVisible: false });
      const aside = container.querySelector("aside");
      expect(aside!.style.width).toBe("0px");
      expect(aside!.style.opacity).toBe("0");
    });
  });

  describe("classic task interface off (default resizable pane)", () => {
    beforeEach(() => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({
        enableClassicTaskInterface: false,
      });
    });

    it("renders the default 322px width with a drag grip and a maximize button", async () => {
      await renderPanel();
      const aside = container.querySelector("aside");
      expect(aside).not.toBeNull();
      expect(aside!.style.width).toBe("322px");
      expect(aside!.querySelector('[role="separator"][aria-label="Resize panel"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Maximize panel"]')).not.toBeNull();
      const inner = aside!.querySelector<HTMLDivElement>(":scope > div:not([role])");
      expect(inner!.style.width).toBe("322px");
      expect(inner!.style.minWidth).toBe("322px");
    });

    it("restores a remembered width from localStorage (clamped to the minimum)", async () => {
      window.localStorage.setItem("taskChatRedesign.propertiesPaneWidth", "300");
      await renderPanel();
      expect(container.querySelector("aside")!.style.width).toBe("300px");
    });

    it("clamps a stored width below the 260px minimum", async () => {
      window.localStorage.setItem("taskChatRedesign.propertiesPaneWidth", "100");
      await renderPanel();
      expect(container.querySelector("aside")!.style.width).toBe("260px");
    });

    it("falls back to the default width when the stored value is garbage", async () => {
      window.localStorage.setItem("taskChatRedesign.propertiesPaneWidth", "not-a-number");
      await renderPanel();
      expect(container.querySelector("aside")!.style.width).toBe("322px");
    });

    it("keeps the collapse-to-0 behavior when the panel is hidden", async () => {
      await renderPanel({ panelVisible: false });
      const aside = container.querySelector("aside");
      expect(aside!.style.width).toBe("0px");
      expect(aside!.style.opacity).toBe("0");
      // No grip while hidden.
      expect(aside!.querySelector('[role="separator"]')).toBeNull();
    });

    it("marks responsive content with the host that owns it", async () => {
      await renderPanel({ panelContent: <PanelHostProbe /> });

      expect(container.querySelectorAll('[data-panel-host="mobile"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-panel-host="desktop"]')).toHaveLength(1);
    });
  });
});

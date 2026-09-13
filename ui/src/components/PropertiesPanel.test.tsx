// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PropertiesPanel } from "./PropertiesPanel";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

const mockPanelState = vi.hoisted(() => ({
  panelContent: null as unknown,
  panelContentMode: "padded" as const,
  panelVisible: true,
  panelMaximizeRequested: false,
}));
const mockSetPanelVisible = vi.hoisted(() => vi.fn());
const mockClearPanelMaximizeRequest = vi.hoisted(() => vi.fn());

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    panelContent: mockPanelState.panelContent,
    panelContentMode: mockPanelState.panelContentMode,
    panelVisible: mockPanelState.panelVisible,
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    setPanelVisible: mockSetPanelVisible,
    togglePanelVisible: vi.fn(),
    panelMaximizeRequested: mockPanelState.panelMaximizeRequested,
    requestPanelMaximize: vi.fn(),
    clearPanelMaximizeRequest: mockClearPanelMaximizeRequest,
  }),
}));

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
  let originalInnerWidth: number;

  async function renderPanel({
    panelVisible = true,
    taskDetailLayout = false,
  }: { panelVisible?: boolean; taskDetailLayout?: boolean } = {}) {
    mockPanelState.panelContent = <div data-testid="panel-content">content</div>;
    mockPanelState.panelVisible = panelVisible;
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <PropertiesPanel taskDetailLayout={taskDetailLayout} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    mockSetPanelVisible.mockClear();
    mockClearPanelMaximizeRequest.mockClear();
    mockPanelState.panelMaximizeRequested = false;
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    vi.clearAllMocks();
  });

  describe("classic task interface on (legacy panel)", () => {
    beforeEach(() => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({
        enableStreamlinedUi: true,
        enableClassicTaskInterface: true,
      });
    });

    it("renders the fixed-width panel with no grip and no maximize button", async () => {
      await renderPanel();
      const aside = container.querySelector("aside");
      expect(aside).not.toBeNull();
      expect(aside!.style.width).toBe("320px");
      expect(aside!.querySelector('[role="separator"]')).toBeNull();
      expect(container.querySelector('[aria-label="Maximize side panel"]')).toBeNull();
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
        enableStreamlinedUi: true,
        enableClassicTaskInterface: false,
      });
    });

    it("renders the Paper task-detail rail width with a drag grip and a maximize button", async () => {
      await renderPanel({ taskDetailLayout: true });
      const aside = container.querySelector("aside");
      expect(aside).not.toBeNull();
      expect(aside!.style.width).toBe("434px");
      expect(aside!.querySelector('[role="separator"][aria-label="Resize panel"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Maximize side panel"]')).not.toBeNull();
      const inner = aside!.querySelector<HTMLDivElement>(":scope > div:not([role])");
      expect(inner!.style.width).toBe("434px");
      expect(inner!.style.minWidth).toBe("434px");
      expect(aside!.querySelector("header")?.className).toContain(
        "h-(--side-panel-header-height)",
      );
    });

    it("removes the left divider only while the sidebar is maximized", async () => {
      await renderPanel({ taskDetailLayout: true });
      const aside = container.querySelector("aside")!;
      const maximize = container.querySelector<HTMLButtonElement>(
        '[aria-label="Maximize side panel"]',
      )!;

      expect(aside.className).toContain("border-l");
      maximize.click();
      await flushReact();

      expect(aside.className).not.toContain("border-l");
      expect(container.querySelector("section")?.getAttribute("data-maximized")).toBe("true");
    });

    it("consumes a pending deep-link maximize request on mount (LOOA-2181)", async () => {
      mockPanelState.panelMaximizeRequested = true;
      await renderPanel({ taskDetailLayout: true });
      expect(mockClearPanelMaximizeRequest).toHaveBeenCalled();
      expect(container.querySelector("section")?.getAttribute("data-maximized")).toBe("true");
    });

    it("holds a deep-link maximize request while the panel is hidden", async () => {
      mockPanelState.panelMaximizeRequested = true;
      await renderPanel({ panelVisible: false });
      expect(mockClearPanelMaximizeRequest).not.toHaveBeenCalled();
      expect(container.querySelector("section")?.getAttribute("data-maximized")).not.toBe("true");
    });

    it("uses an X to close the Streamlined task-detail sidebar", async () => {
      await renderPanel({ taskDetailLayout: true });
      const close = container.querySelector<HTMLButtonElement>('[aria-label="Close side panel"]');
      expect(close).not.toBeNull();
      expect(close!.querySelector(".lucide-x")).not.toBeNull();
      expect(container.querySelector('[aria-label="Toggle side panel"]')).toBeNull();

      close!.click();
      expect(mockSetPanelVisible).toHaveBeenCalledWith(false);
    });

    it("keeps the production toggle control outside Streamlined task detail", async () => {
      await renderPanel();
      const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Toggle side panel"]');
      expect(toggle).not.toBeNull();
      expect(toggle!.getAttribute("aria-pressed")).toBe("true");
      expect(toggle!.querySelector(".lucide-panel-right-close")).not.toBeNull();
      expect(container.querySelector('[aria-label="Close side panel"]')).toBeNull();
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
  });

  describe("Streamlined UI off", () => {
    beforeEach(() => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({
        enableStreamlinedUi: false,
        enableClassicTaskInterface: false,
      });
    });

    it("restores master's default resizable panel rather than the classic panel", async () => {
      await renderPanel({ taskDetailLayout: true });
      const aside = container.querySelector("aside");
      expect(aside).not.toBeNull();
      expect(aside!.style.width).toBe("322px");
      expect(aside!.querySelector('[role="separator"][aria-label="Resize panel"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Maximize side panel"]')).not.toBeNull();
    });

    it("still honors the independent Classic Task Interface preference", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({
        enableStreamlinedUi: false,
        enableClassicTaskInterface: true,
      });
      await renderPanel({ taskDetailLayout: true });
      const aside = container.querySelector("aside");
      expect(aside!.style.width).toBe("320px");
      expect(aside!.querySelector('[role="separator"]')).toBeNull();
    });
  });
});

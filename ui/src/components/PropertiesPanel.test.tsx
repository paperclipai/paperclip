// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PropertiesPanel } from "./PropertiesPanel";

vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true }),
}));

const mockSandbox = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/context/DesignSandboxContext", () => ({ useDesignSandbox: () => mockSandbox.enabled }));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

const mockPanelState = vi.hoisted(() => ({
  panelContent: null as ReactNode,
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
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("PropertiesPanel layout row fitting", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let originalInnerWidth: number;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let queryClient: QueryClient;

  async function renderPanel({
    panelVisible = true,
    taskDetailLayout = true,
    content = <div data-testid="panel-content">content</div>,
    inLayoutRow = true,
  }: {
    panelVisible?: boolean;
    taskDetailLayout?: boolean;
    content?: ReactNode;
    inLayoutRow?: boolean;
  } = {}) {
    mockPanelState.panelContent = content;
    mockPanelState.panelVisible = panelVisible;
    root ??= createRoot(container);
    const panel = <PropertiesPanel taskDetailLayout={taskDetailLayout} />;
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            {inLayoutRow ? (
              <div data-testid="layout-row">
                <div data-testid="chat-area">
                  <main id="main-content" />
                </div>
                {panel}
              </div>
            ) : panel}
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    originalResizeObserver = globalThis.ResizeObserver;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    mockSetPanelVisible.mockClear();
    mockClearPanelMaximizeRequest.mockClear();
    mockPanelState.panelMaximizeRequested = false;
    mockSandbox.enabled = false;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableStreamlinedUi: true,
      enableClassicTaskInterface: false,
    });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    if (originalResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = originalResizeObserver;
    }
    vi.clearAllMocks();
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty("--sz-420px");
  });

  it("fits the pane to its layout row so it is never clipped at the right edge", async () => {
    window.localStorage.setItem("taskChatRedesign.taskDetailPropertiesPaneWidth", "624");
    const geometry = { rowRight: 1280, centerLeft: 700 };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.id === "main-content") return new DOMRect(geometry.centerLeft, 0, 0, 800);
      if (this.getAttribute("data-testid") === "layout-row") return new DOMRect(0, 0, geometry.rowRight, 800);
      return new DOMRect();
    });

    await renderPanel({ taskDetailLayout: true, inLayoutRow: true });
    const aside = container.querySelector("aside")!;
    const inner = aside.querySelector<HTMLDivElement>(":scope > div:not([role]) > div")!;
    expect(aside.style.width).toBe("260px");
    expect(inner.style.width).toBe("260px");

    geometry.centerLeft = 488;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(aside.style.width).toBe("372px");
    expect(inner.style.width).toBe("372px");
    expect(window.localStorage.getItem("taskChatRedesign.taskDetailPropertiesPaneWidth")).toBe("624");

    // Respects the shared --sz-420px minimum center width token when customized.
    document.documentElement.style.setProperty("--sz-420px", "460px");
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(aside.style.width).toBe("332px");
    document.documentElement.style.removeProperty("--sz-420px");

    geometry.rowRight = 1440;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(aside.style.width).toBe("532px");

    // Narrow desktop where space right of center start is below the 260px minimum.
    geometry.rowRight = 900;
    geometry.centerLeft = 700;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(aside.style.width).toBe("200px");
    expect(inner.style.width).toBe("200px");
  });

  it("re-measures when #main-content shifts inside the row without the row resizing", async () => {
    window.localStorage.setItem("taskChatRedesign.taskDetailPropertiesPaneWidth", "624");
    const geometry = { rowRight: 1280, centerLeft: 700 };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.id === "main-content") return new DOMRect(geometry.centerLeft, 0, 0, 800);
      if (this.getAttribute("data-testid") === "layout-row") return new DOMRect(0, 0, geometry.rowRight, 800);
      return new DOMRect();
    });

    const observers = new Map<Element, ResizeObserverCallback[]>();
    class FakeResizeObserver {
      private readonly callback: ResizeObserverCallback;
      private readonly targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.targets.add(target);
        const list = observers.get(target) ?? [];
        list.push(this.callback);
        observers.set(target, list);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        for (const target of this.targets) {
          const list = observers.get(target);
          if (list) {
            const next = list.filter((cb) => cb !== this.callback);
            if (next.length === 0) observers.delete(target);
            else observers.set(target, next);
          }
        }
        this.targets.clear();
      }
    }
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

    await renderPanel({ taskDetailLayout: true, inLayoutRow: true });
    const aside = container.querySelector("aside")!;
    const main = container.querySelector("#main-content")!;
    expect(aside.style.width).toBe("260px");

    // Simulate chat list collapsing inside chatAreaRef: #main-content shifts left,
    // while the outer layout row keeps the exact same width.
    geometry.centerLeft = 420;
    await act(async () => {
      for (const cb of observers.get(main) ?? []) {
        cb([], {} as ResizeObserver);
      }
    });
    expect(aside.style.width).toBe("440px");

    // Simulate chat list reappearing on a tight row: #main-content shifts right again.
    geometry.rowRight = 900;
    geometry.centerLeft = 700;
    await act(async () => {
      for (const cb of observers.get(main) ?? []) {
        cb([], {} as ResizeObserver);
      }
    });
    expect(aside.style.width).toBe("200px");
  });

  it("starts dragging from the fitted width and clamps drags to the layout row", async () => {
    window.localStorage.setItem("taskChatRedesign.taskDetailPropertiesPaneWidth", "624");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.id === "main-content") return new DOMRect(488, 0, 0, 800);
      if (this.getAttribute("data-testid") === "layout-row") return new DOMRect(0, 0, 1280, 800);
      return new DOMRect();
    });

    await renderPanel({ taskDetailLayout: true, inLayoutRow: true });
    const aside = container.querySelector("aside")!;
    const grip = aside.querySelector<HTMLDivElement>('[role="separator"][aria-label="Resize panel"]')!;
    grip.setPointerCapture = vi.fn();
    expect(aside.style.width).toBe("372px");

    await act(async () => {
      grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, pointerType: "mouse", clientX: 908 }));
      grip.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 708 }));
    });
    expect(aside.style.width).toBe("372px");

    await act(async () => {
      grip.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 958 }));
      grip.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 958 }));
    });
    expect(aside.style.width).toBe("322px");
    expect(window.localStorage.getItem("taskChatRedesign.taskDetailPropertiesPaneWidth")).toBe("322");
  });

  it("falls back to window-based clamping when mounted without #main-content", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    window.localStorage.setItem("taskChatRedesign.taskDetailPropertiesPaneWidth", "700");
    await renderPanel({ taskDetailLayout: true, inLayoutRow: false });
    const aside = container.querySelector("aside")!;
    expect(aside.style.width).toBe("344px");
  });
});

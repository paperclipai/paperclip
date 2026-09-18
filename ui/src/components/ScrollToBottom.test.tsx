// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollToBottom } from "./ScrollToBottom";

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: true }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ panelVisible: false, panelContent: null }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("ScrollToBottom mobile composer docking", () => {
  let host: HTMLDivElement;
  let main: HTMLElement;
  let dock: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 0,
    });

    main = document.createElement("main");
    main.id = "main-content";
    dock = document.createElement("div");
    dock.dataset.testid = "task-chat-composer-dock";
    main.appendChild(dock);
    document.body.appendChild(main);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("moves with the active mobile composer dock", async () => {
    await act(async () => {
      root.render(<ScrollToBottom />);
    });

    const initialButton = dock.querySelector<HTMLButtonElement>(
      'button[aria-label="Scroll to bottom"]',
    );
    expect(initialButton).not.toBeNull();
    expect(initialButton?.classList).toContain("absolute");
    expect(host.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull();

    await act(async () => {
      dock.remove();
      await Promise.resolve();
    });

    const fallbackButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Scroll to bottom"]',
    );
    expect(fallbackButton).not.toBeNull();
    expect(fallbackButton?.classList).toContain("fixed");

    const replacementDock = document.createElement("div");
    replacementDock.dataset.testid = "task-chat-composer-dock";
    await act(async () => {
      main.appendChild(replacementDock);
      await Promise.resolve();
    });

    const replacementButton = replacementDock.querySelector<HTMLButtonElement>(
      'button[aria-label="Scroll to bottom"]',
    );
    expect(replacementButton).not.toBeNull();
    expect(replacementButton?.classList).toContain("absolute");
    expect(host.querySelector('button[aria-label="Scroll to bottom"]')).toBeNull();
  });
});

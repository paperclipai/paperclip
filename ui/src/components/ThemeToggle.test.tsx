// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

const mockToggleTheme = vi.hoisted(() => vi.fn());
const mockPreference = vi.hoisted(() => ({
  value: "light" as "light" | "dark" | "system",
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: mockPreference.value === "system" ? "dark" : mockPreference.value,
    themePreference: mockPreference.value,
    toggleTheme: mockToggleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ThemeToggle", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockPreference.value = "light";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders an icon button by default, naming the state it switches to", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Switch to dark mode");
    expect(button?.getAttribute("title")).toBe("Switch to dark mode");

    await act(async () => {
      button?.click();
    });
    expect(mockToggleTheme).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("offers the system theme as the step after dark", async () => {
    mockPreference.value = "dark";
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Switch to system theme");

    await act(async () => root.unmount());
  });

  it("returns to light from the system theme", async () => {
    mockPreference.value = "system";
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Switch to light mode");

    await act(async () => root.unmount());
  });

  it("renders a menu-action row when variant='menu-action' and includes the description text", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="menu-action" />);
    });
    await flushReact();

    expect(container.textContent).toContain("Switch to dark mode");
    expect(container.textContent).toContain("Toggle the app appearance.");

    await act(async () => root.unmount());
  });

  it("renders the compact profile-menu row without secondary copy", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="compact-menu-action" />);
    });
    await flushReact();

    const button = container.querySelector("button");
    expect(button?.classList).toContain("h-(--profile-popover-row-height)");
    expect(button?.classList).toContain("gap-(--profile-popover-row-gap)");
    expect(button?.querySelector("span")?.classList).toContain("size-5");
    expect(container.textContent).toContain("Switch to dark mode");
    expect(container.textContent).not.toContain("Toggle the app appearance.");

    await act(async () => root.unmount());
  });

  it("calls onAfterToggle after toggling (used by SidebarAccountMenu to close the popover)", async () => {
    const onAfterToggle = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="menu-action" onAfterToggle={onAfterToggle} />);
    });
    await flushReact();

    const button = container.querySelector("button");
    await act(async () => {
      button?.click();
    });

    expect(mockToggleTheme).toHaveBeenCalledTimes(1);
    expect(onAfterToggle).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });
});

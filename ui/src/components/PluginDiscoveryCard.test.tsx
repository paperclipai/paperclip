// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginDiscoveryCard, getPluginDiscoveryDescription } from "./PluginDiscoveryCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to, ...props }: ComponentProps<"a"> & { to?: string }) => (
    <a className={className} href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("getPluginDiscoveryDescription", () => {
  it("highlights bundled examples when no plugins are installed", () => {
    expect(getPluginDiscoveryDescription(0, 3)).toContain("3 bundled examples");
  });

  it("highlights installed plugins when plugins are already active", () => {
    expect(getPluginDiscoveryDescription(2, 1)).toContain("2 installed");
  });
});

describe("PluginDiscoveryCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("links directly to Plugin Manager from the dashboard card", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<PluginDiscoveryCard installedCount={1} exampleCount={2} />);
    });

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/instance/settings/plugins");
    expect(container.textContent).toContain("Discover and manage plugins");
    expect(container.textContent).toContain("1 installed");
    expect(container.textContent).toContain("2 bundled examples");

    act(() => {
      root.unmount();
    });
  });
});

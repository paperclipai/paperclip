// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageTabBar } from "./PageTabBar";

const mockUseSidebar = vi.fn();

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockUseSidebar(),
}));

describe("PageTabBar mobile select", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockUseSidebar.mockReturnValue({ isMobile: true });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("extracts readable text from JSX labels for mobile <option> elements", () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <PageTabBar
          value="proposals"
          onValueChange={() => {}}
          items={[
            {
              value: "secrets",
              label: (
                <span>
                  <svg aria-hidden="true"><title>Icon</title></svg>
                  Secrets
                </span>
              ),
            },
            {
              value: "proposals",
              label: (
                <span>
                  <span>Proposals</span>
                  <span>(4)</span>
                </span>
              ),
            },
            {
              value: "pending",
              label: <>Pending <span>12</span></>,
            },
          ]}
        />,
      );
    });

    const options = Array.from(container.querySelectorAll("option")).map((el) => el.textContent);
    expect(options).toEqual(["Secrets", "Proposals (4)", "Pending 12"]);
  });

  it("keeps the select wrapper self-sized with appearance-none so chevron aligns inside select", () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <PageTabBar
          value="general"
          onValueChange={() => {}}
          items={[
            { value: "general", label: "General" },
            { value: "members", label: "Members" },
          ]}
        />,
      );
    });

    const select = container.querySelector("select");
    expect(select).not.toBeNull();
    expect(select?.className).toContain("appearance-none");
    expect(select?.className).toContain("w-full");
    expect(select?.parentElement?.className).toContain("w-fit");
    expect(select?.parentElement?.className).toContain("self-start");
  });
});

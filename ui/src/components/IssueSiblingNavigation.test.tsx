// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueSiblingNavigation } from "./IssueSiblingNavigation";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    issueQuicklookAlign,
    issueQuicklookSide,
    issuePrefetch: _issuePrefetch,
    state: _state,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    issueQuicklookAlign?: string;
    issueQuicklookSide?: string;
    issuePrefetch?: unknown;
    state?: unknown;
    children?: ReactNode;
  }) => (
    <a
      href={to}
      data-quicklook-align={issueQuicklookAlign}
      data-quicklook-side={issueQuicklookSide}
      {...props}
    >
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    identifier: `PAP-${id}`,
    title: `Sibling ${id}`,
    status: "todo",
    blockerAttention: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  } as Issue;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

describe("IssueSiblingNavigation", () => {
  it("renders the locked card anatomy for previous and next siblings", () => {
    const node = render(
      <IssueSiblingNavigation
        navigation={{
          previous: issue("1", { title: "Previous sibling title" }),
          next: issue("3", { title: "Next sibling title" }),
          currentIndex: 1,
          totalCount: 3,
        }}
      />,
    );

    const nav = node.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Sub-issue navigation");
    expect(nav?.className).toContain("sm:grid-cols-2");
    expect(nav?.className).not.toContain("border-t");

    const links = Array.from(node.querySelectorAll("a"));
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toContain("Previous");
    expect(links[0].textContent).toContain("PAP-1");
    expect(links[0].textContent).toContain("Previous sibling title");
    expect(links[0].getAttribute("aria-label")).toBe("Previous sub-issue: PAP-1 - Previous sibling title");
    expect(links[0].getAttribute("data-quicklook-align")).toBe("start");

    expect(links[1].textContent).toContain("Next");
    expect(links[1].textContent).toContain("PAP-3");
    expect(links[1].textContent).toContain("Next sibling title");
    expect(links[1].getAttribute("aria-label")).toBe("Next sub-issue: PAP-3 - Next sibling title");
    expect(links[1].getAttribute("data-quicklook-align")).toBe("end");
    expect(links[1].className).toContain("sm:text-right");

    expect(links[0].className).toContain("rounded-lg");
    expect(links[0].className).toContain("hover:bg-accent/50");
    expect(links[0].className).toContain("focus-visible:ring-[3px]");
    expect(node.querySelector(".truncate")?.textContent).toBe("Previous sibling title");
  });

  it("keeps a lone next card in the right desktop column", () => {
    const node = render(
      <IssueSiblingNavigation
        navigation={{
          previous: null,
          next: issue("2"),
          currentIndex: 0,
          totalCount: 2,
        }}
      />,
    );

    const links = Array.from(node.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain("Next");
    expect(links[0].className).toContain("sm:col-start-2");
    expect(node.textContent).not.toContain("Previous");
  });
});

// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({
    to,
    children,
    className,
    state: _state,
    ...props
  }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
    state?: unknown;
  }) => {
    const linkState = { isActive: false };
    return (
      <a
        href={to}
        className={typeof className === "function" ? className(linkState) : className}
        {...props}
      >
        {typeof children === "function" ? children(linkState) : children}
      </a>
    );
  },
  useLocation: () => ({ pathname: "/dashboard" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dialogState.openNewIssue.mockReset();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("MobileBottomNav inbox badge", () => {
  it("renders the Inbox tab without any badge", () => {
    act(() => {
      root!.render(<MobileBottomNav visible />);
    });

    const inboxLink = container?.querySelector('a[href="/inbox"]') as HTMLAnchorElement | null;
    expect(inboxLink).not.toBeNull();
    expect(inboxLink?.textContent).toBe("Inbox");
    expect(inboxLink?.querySelector('[class*="bg-primary"]')).toBeNull();
  });
});

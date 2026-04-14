// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootstrapPendingPage } from "./components/BootstrapPendingPage";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  Navigate: () => null,
  Outlet: () => null,
  Route: () => null,
  Routes: ({ children }: { children?: unknown }) => <>{children}</>,
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
  useParams: () => ({}),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    asChild,
    children,
    ...props
  }: ComponentProps<"button"> & { asChild?: boolean }) => {
    if (asChild) return children;
    return <button {...props}>{children}</button>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BootstrapPendingPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a claim action for signed-in users", () => {
    const root = createRoot(container);
    const onClaim = vi.fn();

    act(() => {
      root.render(
        <BootstrapPendingPage
          session={{
            session: { id: "session-1", userId: "user-1" },
            user: { id: "user-1", email: "founder@example.com", name: "Founder" },
          }}
          onClaim={onClaim}
        />,
      );
    });

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Claim instance admin");
    expect(container.textContent).toContain("Signed in as Founder");

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onClaim).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("renders a sign-in link and bootstrap invite fallback for signed-out users", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <BootstrapPendingPage
          hasActiveInvite
          signInPath="/auth?next=%2F"
        />,
      );
    });

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/auth?next=%2F");
    expect(link?.textContent).toBe("Sign in / Create account");
    expect(container.textContent).toContain("A bootstrap invite is already active.");
    expect(container.textContent).toContain("pnpm paperclipai onboard");

    act(() => {
      root.unmount();
    });
  });
});

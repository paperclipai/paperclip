// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "./ToastViewport";

const navigateState = vi.hoisted(() => ({
  fn: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  toasts: [] as Array<{
    id: string;
    title: string;
    body?: string;
    tone: "info" | "success" | "warn" | "error";
    ttlMs: number;
    createdAt: number;
    action?: { label: string; href: string };
  }>,
  dismissToast: vi.fn(),
  pauseToast: vi.fn(),
  resumeToast: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, onClick, ...props }: { to: string; children: ReactNode; onClick?: () => void }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
      {...props}
    >
      {children}
    </a>
  ),
  useNavigate: () => navigateState.fn,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastViewport", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    navigateState.fn.mockReset();
    toastState.dismissToast.mockReset();
    toastState.pauseToast.mockReset();
    toastState.resumeToast.mockReset();
    toastState.toasts = [
      {
        id: "toast-1",
        title: "Issue updated",
        body: "Open the issue to review it.",
        tone: "info",
        ttlMs: 6000,
        createdAt: Date.now(),
        action: { label: "View issue", href: "/issues/123" },
      },
    ];
  });

  afterEach(() => {
    container.remove();
  });

  it("navigates when clicking an actionable toast card", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<ToastViewport />);
    });

    const toast = container.querySelector('li[role="link"]') as HTMLLIElement | null;
    expect(toast).not.toBeNull();

    act(() => {
      toast?.click();
    });

    expect(toastState.dismissToast).toHaveBeenCalledWith("toast-1");
    expect(navigateState.fn).toHaveBeenCalledWith("/issues/123");

    act(() => {
      root.unmount();
    });
  });

  it("does not navigate when dismissing an actionable toast", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<ToastViewport />);
    });

    const dismissButton = container.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement | null;
    expect(dismissButton).not.toBeNull();

    act(() => {
      dismissButton?.click();
    });

    expect(toastState.dismissToast).toHaveBeenCalledWith("toast-1");
    expect(navigateState.fn).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("does not navigate when pressing Enter on the dismiss button", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<ToastViewport />);
    });

    const dismissButton = container.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement | null;
    expect(dismissButton).not.toBeNull();

    act(() => {
      dismissButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(navigateState.fn).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});

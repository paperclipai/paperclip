// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionDrawer } from "../ConnectionDrawer";
import type { ConnectionSummary } from "../api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const conn: ConnectionSummary = {
  id: "c-1",
  providerId: "github",
  status: "active",
  accountId: "42",
  accountLabel: "octocat",
  scopes: ["repo"],
  accessTokenExpiresAt: null,
  lastRefreshedAt: null,
  lastError: null,
  lastErrorAt: null,
  refreshAttemptCount: 0,
};

// The Sheet renders into a Radix portal under document.body.
function findButtonByText(text: RegExp): HTMLButtonElement {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const match = buttons.find((b) => text.test(b.textContent ?? ""));
  if (!match) {
    throw new Error(
      `No button matching ${text} — found: ${buttons.map((b) => b.textContent).join(" | ")}`,
    );
  }
  return match as HTMLButtonElement;
}

function queryButtonByText(text: RegExp): HTMLButtonElement | null {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  return (buttons.find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement) ?? null;
}

describe("ConnectionDrawer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // Clean up portals between tests.
    document.body.innerHTML = "";
  });

  it("Refresh button calls onRefresh", () => {
    const root = createRoot(container);
    const onRefresh = vi.fn();
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={conn}
          role="admin"
          onRefresh={onRefresh}
          onDisconnect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    const refreshBtn = findButtonByText(/refresh now/i);
    act(() => {
      refreshBtn.click();
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("Disconnect requires confirmation before firing onDisconnect", () => {
    const root = createRoot(container);
    const onDisconnect = vi.fn();
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={conn}
          role="admin"
          onRefresh={() => {}}
          onDisconnect={onDisconnect}
          onClose={() => {}}
        />,
      );
    });
    // First click reveals confirmation, does NOT call onDisconnect.
    act(() => {
      findButtonByText(/^disconnect$/i).click();
    });
    expect(onDisconnect).not.toHaveBeenCalled();
    // Confirm button now exists.
    const confirmBtn = findButtonByText(/^confirm$/i);
    act(() => {
      confirmBtn.click();
    });
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("hides destructive controls for member role", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={conn}
          role="member"
          onRefresh={() => {}}
          onDisconnect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(queryButtonByText(/disconnect/i)).toBeNull();
    expect(queryButtonByText(/refresh now/i)).toBeNull();
  });

  it("renders nothing when connection is null", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={null}
          role="admin"
          onRefresh={() => {}}
          onDisconnect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(document.body.querySelectorAll('[data-testid="connection-drawer"]').length).toBe(0);
  });

  it("calls onClose when overlay close fires (Sheet onOpenChange)", () => {
    const root = createRoot(container);
    const onClose = vi.fn();
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={conn}
          role="admin"
          onRefresh={() => {}}
          onDisconnect={() => {}}
          onClose={onClose}
        />,
      );
    });
    // Radix Dialog renders a Close button (X) in the SheetContent. Find it via aria-label/sr-only text.
    const closeBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      /close/i.test(b.textContent ?? "") || b.getAttribute("aria-label") === "Close",
    ) as HTMLButtonElement | undefined;
    if (!closeBtn) throw new Error("No close button found");
    act(() => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows lastError block when present", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={{ ...conn, lastError: "refresh_token_invalid", lastErrorAt: new Date().toISOString() }}
          role="admin"
          onRefresh={() => {}}
          onDisconnect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(document.body.textContent).toContain("refresh_token_invalid");
  });

  it("resets the disconnect confirmation when switching to a different connection", () => {
    const root = createRoot(container);
    const onDisconnect = vi.fn();
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={conn}
          role="admin"
          onRefresh={() => {}}
          onDisconnect={onDisconnect}
          onClose={() => {}}
        />,
      );
    });
    // Reveal confirm prompt on connection A.
    act(() => {
      findButtonByText(/^disconnect$/i).click();
    });
    expect(findButtonByText(/^confirm$/i)).toBeTruthy();

    // Switch to a different connection (different id) without closing.
    act(() => {
      root.render(
        <ConnectionDrawer
          connection={{ ...conn, id: "conn-other", providerId: "slack" }}
          role="admin"
          onRefresh={() => {}}
          onDisconnect={onDisconnect}
          onClose={() => {}}
        />,
      );
    });

    // Confirm button is gone — only the initial Disconnect button is back.
    expect(() => findButtonByText(/^confirm$/i)).toThrow();
    expect(findButtonByText(/^disconnect$/i)).toBeTruthy();
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});

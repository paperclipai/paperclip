// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderTile } from "../ProviderTile";
import type { ConnectionSummary, ProviderSummary } from "../api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseProvider: ProviderSummary = {
  id: "github",
  displayName: "GitHub",
  scopesDefault: ["repo", "read:user"],
  scopesOffered: ["repo", "read:user", "workflow"],
};

const activeConnection: ConnectionSummary = {
  id: "conn-1",
  providerId: "github",
  status: "active",
  accountId: "42",
  accountLabel: "octocat",
  scopes: ["repo"],
  accessTokenExpiresAt: null,
  lastRefreshedAt: new Date().toISOString(),
  lastError: null,
  lastErrorAt: null,
  refreshAttemptCount: 0,
};

function findButtonByText(container: HTMLElement, text: RegExp): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const match = buttons.find((b) => text.test(b.textContent ?? ""));
  if (!match) {
    throw new Error(
      `No button matching ${text} — found: ${buttons.map((b) => b.textContent).join(" | ")}`,
    );
  }
  return match as HTMLButtonElement;
}

describe("ProviderTile", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders Connect button for unconnected provider as admin", () => {
    const root = createRoot(container);
    const onConnect = vi.fn();
    act(() => {
      root.render(
        <ProviderTile
          provider={baseProvider}
          connection={null}
          role="admin"
          onConnect={onConnect}
          onManage={() => {}}
        />,
      );
    });
    const button = findButtonByText(container, /connect/i);
    expect(button.disabled).toBe(false);
    act(() => {
      button.click();
    });
    expect(onConnect).toHaveBeenCalled();
  });

  it("disables Connect for member role and shows tooltip via title", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ProviderTile
          provider={baseProvider}
          connection={null}
          role="member"
          onConnect={() => {}}
          onManage={() => {}}
        />,
      );
    });
    const button = findButtonByText(container, /connect/i);
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/ask an admin/i);
  });

  it("renders account label and Manage button when connected", () => {
    const root = createRoot(container);
    const onManage = vi.fn();
    act(() => {
      root.render(
        <ProviderTile
          provider={baseProvider}
          connection={activeConnection}
          role="admin"
          onConnect={() => {}}
          onManage={onManage}
        />,
      );
    });
    expect(container.textContent).toContain("octocat");
    expect(container.textContent).toMatch(/connected/i);
    const button = findButtonByText(container, /manage/i);
    act(() => {
      button.click();
    });
    expect(onManage).toHaveBeenCalled();
  });

  it("shows Reconnect on revoked connection and routes to onConnect (not onManage)", () => {
    const onConnect = vi.fn();
    const onManage = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <ProviderTile
          provider={baseProvider}
          connection={{
            ...activeConnection,
            status: "revoked",
            lastError: "revoked_by_user",
          }}
          role="admin"
          onConnect={onConnect}
          onManage={onManage}
        />,
      );
    });
    const btn = findButtonByText(container, /reconnect/i);
    expect(btn).toBeTruthy();
    expect(container.textContent).toMatch(/revoked/i);
    act(() => {
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();
  });

  it("shows stalled state when active but with lastError", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ProviderTile
          provider={baseProvider}
          connection={{
            ...activeConnection,
            status: "error",
            lastError: "refresh_failed",
          }}
          role="admin"
          onConnect={() => {}}
          onManage={() => {}}
        />,
      );
    });
    expect(container.textContent).toMatch(/stalled/i);
  });
});

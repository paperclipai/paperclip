// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicesList } from "./ServicesPanel";
import type { ComposioServiceRow } from "../composio-services";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  // The row's "Manage" affordance only has to be a link with the right target;
  // exercising the real router here would test the router, not the panel.
  Link: ({ to, children, ...rest }: { to: string; children?: unknown }) => (
    <a href={to} {...rest}>{children as never}</a>
  ),
}));

function act(callback: () => void) {
  flushSync(callback);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  container = null;
  root = null;
});

function row(over: Partial<ComposioServiceRow> & { toolkitSlug: string }): ComposioServiceRow {
  return {
    name: over.toolkitSlug,
    description: null,
    logoUrl: null,
    state: "not_connected",
    connectedAccountStatus: null,
    childConnectionId: null,
    toolCount: null,
    noAuth: false,
    ...over,
  };
}

function renderList(rows: ComposioServiceRow[], handlers: {
  onConnect?: (row: ComposioServiceRow) => void;
  onRecheck?: (row: ComposioServiceRow) => void;
  onDisconnect?: (row: ComposioServiceRow) => void;
} = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const renderRoot = createRoot(container);
  root = renderRoot;
  act(() => renderRoot.render(
    <ServicesList
      rows={rows}
      busySlug={null}
      onConnect={handlers.onConnect ?? vi.fn()}
      onRecheck={handlers.onRecheck ?? vi.fn()}
      onDisconnect={handlers.onDisconnect ?? vi.fn()}
    />,
  ));
  return container;
}

function buttonLabelled(node: HTMLElement, label: string) {
  return Array.from(node.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
}

/**
 * The three states the design asks for, plus the `attention` state Composio can
 * report. Each state has to be distinguishable *and* offer the one action that
 * moves it forward — a "Connected" row that still says "Connect" would be the
 * bug this covers.
 */
describe("ServicesList row states", () => {
  it("offers Connect on a not-connected service", () => {
    const node = renderList([row({ toolkitSlug: "gmail", name: "Gmail", description: "Email" })]);
    const text = node.textContent ?? "";

    expect(text).toContain("Gmail");
    expect(text).toContain("Not connected");
    expect(buttonLabelled(node, "Connect")).toBeTruthy();
    expect(buttonLabelled(node, "Disconnect")).toBeFalsy();
  });

  it("shows a pending service as waiting, with no Connect to click twice", () => {
    const node = renderList([row({
      toolkitSlug: "slack",
      name: "Slack",
      state: "pending",
      connectedAccountStatus: "INITIALIZING",
    })]);
    const text = node.textContent ?? "";

    expect(text).toContain("Pending");
    expect(text).toContain("Waiting for Composio to confirm the connection.");
    expect(buttonLabelled(node, "Connect")).toBeFalsy();
    // Re-check is the only affordance, so an impatient user cannot mint a second link.
    expect(node.querySelector('[aria-label="Check Slack again"]')).toBeTruthy();
  });

  it("shows a connected service with Manage and Disconnect", () => {
    const node = renderList([row({
      toolkitSlug: "github",
      name: "GitHub",
      state: "connected",
      connectedAccountStatus: "ACTIVE",
      childConnectionId: "child-1",
      toolCount: 12,
    })]);
    const text = node.textContent ?? "";

    expect(text).toContain("Connected");
    expect(text).toContain("12 actions");
    expect(buttonLabelled(node, "Connect")).toBeFalsy();
    expect(buttonLabelled(node, "Disconnect")).toBeTruthy();
    const manage = node.querySelector<HTMLAnchorElement>('a[href="/apps/child-1/permissions"]');
    expect(manage?.textContent).toContain("Manage");
  });

  /**
   * An expired credential is neither "connected" nor "still working": it needs the
   * user. It therefore gets Reconnect *and* Disconnect, and says what Composio
   * reported, so the reader is not left guessing why a green row went quiet.
   */
  it("explains an unusable credential and offers Reconnect", () => {
    const node = renderList([row({
      toolkitSlug: "hubspot",
      name: "HubSpot",
      state: "attention",
      connectedAccountStatus: "EXPIRED",
      childConnectionId: "child-2",
    })]);
    const text = node.textContent ?? "";

    expect(text).toContain("Needs attention");
    expect(text).toContain("Composio reports this connection as expired");
    expect(buttonLabelled(node, "Reconnect")).toBeTruthy();
    expect(buttonLabelled(node, "Disconnect")).toBeTruthy();
  });

  it("renders every state together without collapsing any of them", () => {
    const node = renderList([
      row({ toolkitSlug: "github", name: "GitHub", state: "connected", childConnectionId: "c1" }),
      row({ toolkitSlug: "slack", name: "Slack", state: "pending" }),
      row({ toolkitSlug: "gmail", name: "Gmail" }),
      row({ toolkitSlug: "hubspot", name: "HubSpot", state: "attention", connectedAccountStatus: "EXPIRED" }),
    ]);

    expect(node.querySelectorAll("li")).toHaveLength(4);
    const text = node.textContent ?? "";
    for (const label of ["Connected", "Pending", "Not connected", "Needs attention"]) {
      expect(text).toContain(label);
    }
  });
});

describe("ServicesList actions", () => {
  it("asks to connect the row that was clicked", () => {
    const onConnect = vi.fn();
    const node = renderList([
      row({ toolkitSlug: "gmail", name: "Gmail" }),
      row({ toolkitSlug: "asana", name: "Asana" }),
    ], { onConnect });

    const asanaRow = Array.from(node.querySelectorAll("li"))
      .find((item) => item.textContent?.includes("Asana"));
    const connect = Array.from(asanaRow!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Connect");

    act(() => connect!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0]![0].toolkitSlug).toBe("asana");
  });

  /** Disconnect is destructive, so the row must not act on its own — it asks first. */
  it("routes Disconnect through the caller's confirm step", () => {
    const onDisconnect = vi.fn();
    const node = renderList([row({
      toolkitSlug: "github",
      name: "GitHub",
      state: "connected",
      childConnectionId: "c1",
    })], { onDisconnect });

    act(() => buttonLabelled(node, "Disconnect")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect.mock.calls[0]![0].toolkitSlug).toBe("github");
  });

  it("disables the row's actions while it is busy", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const renderRoot = createRoot(container);
    root = renderRoot;
    act(() => renderRoot.render(
      <ServicesList
        rows={[row({ toolkitSlug: "gmail", name: "Gmail" })]}
        busySlug="gmail"
        onConnect={vi.fn()}
        onRecheck={vi.fn()}
        onDisconnect={vi.fn()}
      />,
    ));

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});

/**
 * The tab must never render session or MCP credential material. The panel is
 * given rows that deliberately have no such field, so this asserts the row type
 * stays that way: if a future change threads a session URL or header into the
 * row, this catches it at the render boundary.
 */
describe("ServicesList credential hygiene", () => {
  it("renders no URL or bearer-looking text for a connected service", () => {
    const node = renderList([row({
      toolkitSlug: "github",
      name: "GitHub",
      state: "connected",
      connectedAccountStatus: "ACTIVE",
      childConnectionId: "child-1",
    })]);
    const text = node.textContent ?? "";

    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/bearer/i);
    expect(text).not.toMatch(/x-api-key/i);
    // The Composio account id is an opaque handle, but it has no reason to be on screen.
    expect(text).not.toContain("ca-");
  });
});

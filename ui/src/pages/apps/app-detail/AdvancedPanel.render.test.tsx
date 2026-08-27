// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DangerZone } from "./AdvancedPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

function renderDangerZone() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<DangerZone appName="PostHog" removing={false} onRemove={vi.fn()} />));
  return container;
}

function renderComposioDangerZone() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(
    <DangerZone appName="Composio" childConnectionCount={2} removing={false} onRemove={vi.fn()} />,
  ));
  return container;
}

function expandDangerZone(node: HTMLDivElement) {
  const trigger = Array.from(node.querySelectorAll("button"))
    .find((button) => button.textContent?.includes("Danger zone"));
  expect(trigger).toBeTruthy();
  act(() => trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/**
 * Remove app deletes the operator's credentials and revokes agent access
 * (PAP-17119). The compact confirmation still names both effects before the
 * operator commits.
 */
describe("DangerZone", () => {
  it("keeps dangerous actions folded by default", () => {
    const node = renderDangerZone();

    expect(node.textContent).toContain("Danger zone");
    expect(node.textContent).not.toContain("Remove app");
    expect(node.textContent).not.toContain("Deletes credentials");
  });

  it("promises credential deletion and re-authentication before the operator confirms", () => {
    const node = renderDangerZone();
    expandDangerZone(node);
    const text = node.textContent ?? "";

    expect(text).toContain("Deletes credentials for PostHog");
    expect(text).toContain("removes agent access");
    expect(text).toContain("requires a new sign-in or key");
  });

  it("keeps the warning visible in the confirming state", () => {
    const node = renderDangerZone();
    expandDangerZone(node);
    const trigger = Array.from(node.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Remove app");
    expect(trigger).toBeTruthy();

    act(() => trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const text = node.textContent ?? "";
    expect(text).toContain("Yes, remove it");
    expect(text).toContain("Deletes credentials for PostHog");
    expect(text).toContain("requires a new sign-in or key");
  });

  it("names every child service that parent removal will take down", () => {
    const node = renderComposioDangerZone();
    expandDangerZone(node);
    expect(node.textContent).toContain("2 connected services");
  });
});

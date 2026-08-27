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

/**
 * Remove app deletes the operator's credentials and revokes agent access
 * (PAP-17119). The confirmation has to say so before the operator commits — a
 * "you can connect it again later" reassurance implies the pasted key survives,
 * so these assertions exist to stop that copy coming back.
 */
describe("DangerZone", () => {
  it("promises credential deletion and re-authentication before the operator confirms", () => {
    const text = renderDangerZone().textContent ?? "";

    expect(text).toContain("Deletes the saved credentials for PostHog");
    expect(text).toContain("takes agent access away right away");
    expect(text).toContain("needs a new sign-in or key");
    expect(text).not.toContain("You can connect it again later");
  });

  it("keeps the warning visible in the confirming state", () => {
    const node = renderDangerZone();
    const trigger = Array.from(node.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Remove app");
    expect(trigger).toBeTruthy();

    act(() => trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const text = node.textContent ?? "";
    expect(text).toContain("Yes, remove it");
    expect(text).toContain("Deletes the saved credentials for PostHog");
    expect(text).toContain("needs a new sign-in or key");
  });
});

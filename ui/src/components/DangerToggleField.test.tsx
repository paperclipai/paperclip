// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DangerToggleField } from "./DangerToggleField";

// Radix Dialog needs a couple of DOM APIs jsdom omits.
const OriginalPointerEvent = globalThis.PointerEvent;
beforeAll(() => {
  if (!globalThis.PointerEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.PointerEvent = class extends Event {} as any;
  }
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
  if (!globalThis.ResizeObserver) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
});
afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.PointerEvent = OriginalPointerEvent as any;
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function render(node: React.ReactElement) {
  flushSync(() => root.render(node));
}

const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid="dt"]')!;
const confirmBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="dt-confirm"]');

describe("DangerToggleField", () => {
  it("does not enable without confirming — opens a consequence dialog first", async () => {
    const onChange = vi.fn();
    render(
      <DangerToggleField
        label="Skip permission prompts"
        toggleTestId="dt"
        confirmBody="It runs unattended."
        checked={false}
        onChange={onChange}
      />,
    );

    toggle().click();
    await flush();

    // Enabling must NOT apply until confirmed.
    expect(onChange).not.toHaveBeenCalled();
    // A confirm dialog with the consequence copy is shown.
    expect(confirmBtn()).toBeTruthy();
    expect(document.body.textContent).toContain("It runs unattended.");

    confirmBtn()!.click();
    await flush();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("disables immediately without a dialog", async () => {
    const onChange = vi.fn();
    render(
      <DangerToggleField
        label="Skip permission prompts"
        toggleTestId="dt"
        confirmBody="It runs unattended."
        checked
        onChange={onChange}
      />,
    );

    toggle().click();
    await flush();

    expect(onChange).toHaveBeenCalledWith(false);
    expect(confirmBtn()).toBeNull();
  });
});

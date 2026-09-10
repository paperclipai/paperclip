// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mountedRoots: Root[] = [];


async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderIcon(props: ComponentProps<typeof StatusIcon>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(<StatusIcon {...props} />);
  });
  return container;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}


describe("StatusIcon picker scoping", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });


  it("opens a picker without controller-owned options and still offers Done", async () => {
    const onChange = vi.fn();
    const container = renderIcon({ status: "todo", onChange });

    const trigger = container.querySelector('button[aria-label^="Change status"]');
    expect(trigger).toBeTruthy();
    click(trigger!);

    await waitForAssertion(() => {
      expect(Array.from(document.body.querySelectorAll("button")).some((button) => button.textContent?.endsWith("Done"))).toBe(true);
    });

    const labels = Array.from(document.body.querySelectorAll("button")).map((button) => button.textContent);
    expect(labels.some((label) => label?.includes("Ready To Merge") || label?.includes("Merging"))).toBe(false);

    const doneOption = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.endsWith("Done"),
    );
    expect(doneOption).toBeTruthy();
    click(doneOption!);
    expect(onChange).toHaveBeenCalledWith("done");
  });
});

// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe("StatusIcon disabled statuses", () => {
  it("disables stage-advancing choices while leaving other statuses available", () => {
    const onChange = vi.fn();
    const node = render(
      <StatusIcon
        status="in_review"
        onChange={onChange}
        showLabel
        disabledStatuses={["done", "in_progress"]}
        disabledStatusReason="Use the review form."
      />,
    );

    act(() => (node.querySelector("button") as HTMLButtonElement).click());
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const done = buttons.find((button) => button.textContent?.includes("Done"))!;
    const blocked = buttons.find((button) => button.textContent?.includes("Blocked"))!;

    expect(done.getAttribute("aria-disabled")).toBe("true");
    expect(done.title).toBe("Use the review form.");
    expect(blocked.disabled).toBe(false);

    act(() => done.click());
    expect(onChange).not.toHaveBeenCalled();

    act(() => blocked.click());
    expect(onChange).toHaveBeenCalledWith("blocked");
  });
});

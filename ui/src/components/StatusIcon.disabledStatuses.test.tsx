// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
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

function findStatusOptionByLabel(label: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(label),
    ) as HTMLButtonElement | undefined
  ) ?? null;
}

describe("StatusIcon disabledStatuses", () => {
  it("disables and ignores clicks on listed status entries", () => {
    const onChange = vi.fn();
    const node = render(
      <StatusIcon
        status="in_review"
        onChange={onChange}
        showLabel
        disabledStatuses={["done", "in_progress"]}
        disabledStatusReason="Use the approval form"
      />,
    );

    const trigger = node.querySelector("button") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());

    const doneOption = findStatusOptionByLabel("Done");
    const inProgressOption = findStatusOptionByLabel("In Progress");
    const cancelledOption = findStatusOptionByLabel("Cancelled");

    expect(doneOption?.disabled).toBe(true);
    expect(doneOption?.getAttribute("title")).toBe("Use the approval form");
    expect(inProgressOption?.disabled).toBe(true);
    expect(cancelledOption?.disabled).toBe(false);

    act(() => doneOption?.click());
    expect(onChange).not.toHaveBeenCalled();

    act(() => cancelledOption?.click());
    expect(onChange).toHaveBeenCalledWith("cancelled");
  });

  it("leaves all entries clickable when disabledStatuses is omitted", () => {
    const onChange = vi.fn();
    const node = render(<StatusIcon status="in_review" onChange={onChange} showLabel />);

    const trigger = node.querySelector("button");
    act(() => trigger?.click());

    const doneOption = findStatusOptionByLabel("Done");
    expect(doneOption?.disabled).toBe(false);

    act(() => doneOption?.click());
    expect(onChange).toHaveBeenCalledWith("done");
  });
});

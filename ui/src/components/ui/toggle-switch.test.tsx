// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToggleSwitch } from "./toggle-switch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

function click(el: Element) {
  flushSync(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

it("fires onCheckedChange when clicked", () => {
  const onCheckedChange = vi.fn();
  flushSync(() => {
    root.render(<ToggleSwitch checked={false} onCheckedChange={onCheckedChange} />);
  });
  click(container.querySelector('[role="switch"]')!);
  expect(onCheckedChange).toHaveBeenCalledWith(true);
});

// Regression for PAP-12392: a caller-supplied onClick (e.g. stopPropagation in
// a clickable table row) must NOT clobber the internal toggle — both run.
it("runs the caller's onClick and still toggles", () => {
  const onClick = vi.fn();
  const onCheckedChange = vi.fn();
  flushSync(() => {
    root.render(
      <ToggleSwitch
        checked
        onClick={onClick}
        onCheckedChange={onCheckedChange}
      />,
    );
  });
  click(container.querySelector('[role="switch"]')!);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(onCheckedChange).toHaveBeenCalledWith(false);
});

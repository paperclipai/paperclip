// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DraftNumberInput } from "./agent-config-primitives";

let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function renderInput(immediate: boolean, bounds: { min?: number | string; max?: number | string } = { min: 0 }) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onCommit = vi.fn();
  await act(async () => root.render(<DraftNumberInput value={1800} onCommit={onCommit} immediate={immediate} {...bounds} />));
  const input = container.querySelector("input")!;
  const change = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const blur = async () => act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  return { container, input, onCommit, change, blur };
}

it.each([true, false])("rejects negative drafts and restores the saved value on blur (immediate=%s)", async immediate => {
  const { container, input, onCommit, change, blur } = await renderInput(immediate);
  await change("");
  await change("-1");
  expect(onCommit).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a number of at least 0.");
  await blur();
  expect(onCommit).not.toHaveBeenCalled();
  expect(input.value).toBe("1800");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await change("0");
  await blur();
  expect(onCommit).toHaveBeenLastCalledWith(0);
});

it("enforces string bounds on commits", async () => {
  const { onCommit, change, blur } = await renderInput(true, { min: "0", max: "3600" });
  await change("3601");
  await blur();
  expect(onCommit).not.toHaveBeenCalled();
  await change("3600");
  expect(onCommit).toHaveBeenLastCalledWith(3600);
});

it("preserves fractional timeouts within range", async () => {
  const { onCommit, change } = await renderInput(true);
  await change("0.5");
  expect(onCommit).toHaveBeenLastCalledWith(0.5);
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StatusIcon } from "./StatusIcon";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function pick(from: string, label: string, showLabel = false) {
  const onChange = vi.fn();
  await act(async () => root.render(<StatusIcon status={from} onChange={onChange} showLabel={showLabel} />));
  await act(async () => container.querySelector<HTMLButtonElement>("button[aria-label^='Change status']")!.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>("[data-slot='popover-content'] button")]
    .find((button) => button.textContent?.toLowerCase().endsWith(label.toLowerCase()))!;
  await act(async () => option.click());
  return onChange;
}
const burst = () => document.querySelector("[data-finish-burst]");

it.each([false, true])("celebrates when a task is finished (label shown: %s)", async (showLabel) => {
  const onChange = await pick("in_progress", "Done", showLabel);
  expect(onChange).toHaveBeenCalledWith("done");
  expect(burst()).not.toBeNull();
});

it("does not celebrate other status changes", async () => {
  await pick("todo", "In Progress");
  expect(burst()).toBeNull();
});

it("does not celebrate a task that is already done", async () => {
  await pick("done", "Done");
  expect(burst()).toBeNull();
});

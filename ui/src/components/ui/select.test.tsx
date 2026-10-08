// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectPopover } from "./select";

let root: Root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function renderPicker(onChange = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  function Fixture() {
    const [value, setValue] = useState("legacy");
    return <SelectPopover aria-label="Runner" value={value}
      onValueChange={next => { setValue(next); onChange(next); }}
      options={[
        { value: "unavailable", label: "Unavailable", disabled: true },
        { value: "paperclip", label: "Paperclip Runner (default)" },
        { value: "legacy", label: "Legacy runner" },
      ]} />;
  }
  await act(async () => root.render(<Fixture />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  return { container, onChange };
}

describe("SelectPopover", () => {
  it("focuses the saved selection, skips disabled choices, and commits the selected runner", async () => {
    const { container, onChange } = await renderPicker();
    expect(document.activeElement?.textContent).toBe("Legacy runner");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Paperclip Runner (default)");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("paperclip");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(container.textContent).toBe("Paperclip Runner (default)");
  });

  it("dismisses with Escape without changing the saved legacy runner", async () => {
    const { container, onChange } = await renderPicker();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Legacy runner");
    expect(document.activeElement).toBe(container.querySelector("button"));
  });
});

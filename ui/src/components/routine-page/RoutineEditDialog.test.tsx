// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ROUTINE_FORM_DRAFT, RoutineEditDialog, type RoutineFormDraft } from "./RoutineEditDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/MarkdownEditor", () => ({ MarkdownEditor: () => <div data-testid="markdown-editor" /> }));
vi.mock("@/components/RoutineVariablesEditor", () => ({ RoutineVariablesEditor: () => null }));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(name: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.trim() === name);
}

const initial: RoutineFormDraft = { ...EMPTY_ROUTINE_FORM_DRAFT, title: "Send the weekly digest", responsibleUserId: "user-1" };
const people = [
  { id: "user-1", name: "Riley Board" },
  { id: "user-2", name: "Sam Ops" },
];

describe("RoutineEditDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSave = vi.fn();

  async function render(draft: RoutineFormDraft = initial) {
    await act(async () => {
      root.render(
        <RoutineEditDialog
          open
          onOpenChange={() => {}}
          initial={draft}
          agents={[]}
          projects={[]}
          people={people}
          secrets={[]}
          onSave={onSave}
          onCreateSecret={vi.fn()}
        />,
      );
      await flush();
    });
  }

  beforeEach(() => {
    onSave.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("saves a change made only to Secrets", async () => {
    await render();
    expect(button("Save changes")?.disabled).toBe(true);
    await act(async () => { button("Add secret")!.click(); await flush(); });
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    await act(async () => { type(name, "API_TOKEN"); await flush(); });
    const value = document.querySelector<HTMLInputElement>('input[aria-label="Variable value"]')!;
    await act(async () => { type(value, "plain-value"); await flush(); });
    expect(button("Save changes")?.disabled).toBe(false);
    await act(async () => { button("Save changes")!.click(); await flush(); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].env).toMatchObject({ API_TOKEN: expect.anything() });
  });

  it("asks before discarding a change made only to Secrets", async () => {
    await render();
    await act(async () => { button("Add secret")!.click(); await flush(); });
    const name = document.querySelector<HTMLInputElement>('input[aria-label="Variable name"]')!;
    await act(async () => { type(name, "API_TOKEN"); await flush(); });
    await act(async () => { button("Cancel")!.click(); await flush(); });
    expect(document.body.textContent).toContain("Discard your changes?");
  });

  it("keeps the draft open while saving, whatever closes it", async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <RoutineEditDialog open onOpenChange={onOpenChange} initial={initial} agents={[]} projects={[]} people={people}
          secrets={[]} saving onSave={onSave} onCreateSecret={vi.fn()} />,
      );
      await flush();
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await act(async () => { await flush(); });
    const close = document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"], button[aria-label="Close"]');
    if (close) await act(async () => { close.click(); await flush(); });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("does not offer clearing a responsible user, which the server cannot do", async () => {
    await render();
    const picker = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes("Riley Board"))!;
    await act(async () => { picker.click(); await flush(); });
    expect(document.body.textContent).toContain("Sam Ops");
    expect(Array.from(document.querySelectorAll('[role="option"], button')).some((element) => element.textContent?.trim() === "No one")).toBe(false);
  });
});

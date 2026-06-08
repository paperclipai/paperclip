// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionToolbar } from "./SelectionToolbar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SelectionToolbar", () => {
  it("invokes onComment when Comment is clicked", async () => {
    const onComment = vi.fn();
    await act(() =>
      root.render(<SelectionToolbar onComment={onComment} onSuggest={vi.fn()} onCopyLink={vi.fn()} />),
    );
    await act(() => container.querySelector<HTMLButtonElement>('[data-testid="selection-toolbar-comment"]')!.click());
    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it("renders the Suggest edit trigger and copy-link button", async () => {
    await act(() =>
      root.render(<SelectionToolbar onComment={vi.fn()} onSuggest={vi.fn()} onCopyLink={vi.fn()} />),
    );
    expect(container.querySelector('[data-testid="selection-toolbar-suggest"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="selection-toolbar-copy"]')).not.toBeNull();
  });

  it("disables actions when comment/suggest are disabled", async () => {
    await act(() =>
      root.render(
        <SelectionToolbar
          onComment={vi.fn()}
          onSuggest={vi.fn()}
          commentDisabled
          suggestDisabled
        />,
      ),
    );
    expect(container.querySelector<HTMLButtonElement>('[data-testid="selection-toolbar-comment"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="selection-toolbar-suggest"]')!.disabled).toBe(true);
    // No copy-link handler → button omitted.
    expect(container.querySelector('[data-testid="selection-toolbar-copy"]')).toBeNull();
  });
});

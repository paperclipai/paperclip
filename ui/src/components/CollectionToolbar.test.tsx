// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CollectionToolbar } from "./CollectionToolbar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CollectionToolbar", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("keeps collection controls in stable semantic slots", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <CollectionToolbar
          ariaLabel="Task list controls"
          context={<span>Mine</span>}
          search={<input aria-label="Search tasks" />}
          controls={<button type="button">Filter</button>}
          actions={<button type="button">New task</button>}
          feedback={<span>Status: active</span>}
        />,
      );
    });

    const toolbar = container.querySelector('[role="toolbar"]');
    expect(toolbar?.getAttribute("aria-label")).toBe("Task list controls");
    expect(toolbar?.querySelector('[data-slot="collection-toolbar-context"]')?.textContent).toBe("Mine");
    expect(toolbar?.querySelector('[data-slot="collection-toolbar-search"] input')).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="collection-toolbar-controls"]')?.textContent).toBe("Filter");
    expect(toolbar?.querySelector('[data-slot="collection-toolbar-actions"]')?.textContent).toBe("New task");
    expect(toolbar?.querySelector('[data-slot="collection-toolbar-feedback"]')?.textContent).toBe("Status: active");
  });

  it("omits empty optional slots", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(<CollectionToolbar search={<span>Search</span>} />));

    expect(container.querySelector('[data-slot="collection-toolbar-context"]')).toBeNull();
    expect(container.querySelector('[data-slot="collection-toolbar-controls"]')).toBeNull();
    expect(container.querySelector('[data-slot="collection-toolbar-actions"]')).toBeNull();
    expect(container.querySelector('[data-slot="collection-toolbar-feedback"]')).toBeNull();
  });
});

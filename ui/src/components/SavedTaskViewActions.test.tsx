// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { SavedTaskView } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SavedTaskViewActions } from "./SavedTaskViewActions";
import type { UseSavedTaskViewsResult } from "../hooks/useSavedTaskViews";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

async function act<T>(callback: () => T | Promise<T>): Promise<T> {
  if (typeof reactAct === "function") return await (reactAct(callback) as T | Promise<T>);
  let result: T | Promise<T> | undefined;
  flushSync(() => { result = callback(); });
  return await (result as T);
}

function savedView(id: string, name: string): SavedTaskView {
  return {
    id,
    name,
    companyId: "company-1",
    collectionKey: "paperclip:issues-view",
    viewState: { statuses: ["todo"] },
    position: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const createMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();

/** Just enough of the hook for the actions to render; the calls are spies. */
function stubSavedViews(): UseSavedTaskViewsResult {
  return {
    views: [savedView("v1", "Ready to start")],
    isLoading: false,
    isResolving: false,
    isAvailable: true,
    error: null,
    create: { mutateAsync: createMutateAsync, isPending: false },
    update: { mutateAsync: updateMutateAsync, isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
    addStarterViews: { mutateAsync: vi.fn(), isPending: false },
  } as unknown as UseSavedTaskViewsResult;
}

let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement) {
  await act(async () => { root.render(element); });
}

function button(label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button"))
    .find((node) => (node.textContent ?? "").includes(label)) ?? null;
}

describe("SavedTaskViewActions", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    createMutateAsync.mockReset();
    updateMutateAsync.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("offers Save view on a built-in view with nothing blocking it", async () => {
    await render(
      <SavedTaskViewActions
        savedViews={stubSavedViews()}
        activeView={null}
        currentViewState={{ statuses: ["todo"] }}
        hasUnsavedChanges={false}
        onSaved={() => {}}
        onDeleted={() => {}}
      />,
    );

    expect(button("Save view")?.disabled).toBe(false);
  });

  // The list reached from an agent's "See all" is narrowed server-side by a
  // filter the definition has no field for. Saving it would write a view that
  // reopens showing tasks the user never asked for.
  it("refuses to save, and says why, while a filter the view cannot hold is on", async () => {
    const reason = "This list is filtered to one agent, which a saved view cannot hold.";
    await render(
      <SavedTaskViewActions
        savedViews={stubSavedViews()}
        activeView={null}
        currentViewState={{ statuses: ["todo"] }}
        hasUnsavedChanges={false}
        saveBlockedReason={reason}
        onSaved={() => {}}
        onDeleted={() => {}}
      />,
    );

    const save = button("Save view");
    expect(save?.disabled).toBe(true);
    expect(save?.getAttribute("title")).toBe(reason);
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("refuses to update an open view for the same reason, and keeps the reason on the button", async () => {
    const reason = "This list is filtered to one agent, which a saved view cannot hold.";
    await render(
      <SavedTaskViewActions
        savedViews={stubSavedViews()}
        activeView={savedView("v1", "Ready to start")}
        currentViewState={{ statuses: ["backlog"] }}
        hasUnsavedChanges
        saveBlockedReason={reason}
        onSaved={() => {}}
        onDeleted={() => {}}
      />,
    );

    const update = button("Update view");
    expect(update?.disabled).toBe(true);
    expect(update?.getAttribute("title")).toBe(reason);

    await act(async () => { update?.click(); });
    expect(updateMutateAsync).not.toHaveBeenCalled();
  });

  it("updates the open view when nothing is blocking", async () => {
    updateMutateAsync.mockResolvedValue(savedView("v1", "Ready to start"));
    await render(
      <SavedTaskViewActions
        savedViews={stubSavedViews()}
        activeView={savedView("v1", "Ready to start")}
        currentViewState={{ statuses: ["backlog"] }}
        hasUnsavedChanges
        onSaved={() => {}}
        onDeleted={() => {}}
      />,
    );

    const update = button("Update view");
    expect(update?.disabled).toBe(false);
    await act(async () => { update?.click(); });
    expect(updateMutateAsync).toHaveBeenCalledWith({ id: "v1", viewState: { statuses: ["backlog"] } });
  });
});

// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { SavedTaskView } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskViewsMenu } from "./TaskViewsMenu";
import type { TaskSurfaceViewKey } from "../lib/task-views";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    viewState: { statuses: ["todo", "backlog"] },
    position: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

function findByText(label: string): HTMLElement | null {
  const nodes = Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem'], button"));
  return nodes.find((node) => (node.textContent ?? "").includes(label)) ?? null;
}

async function openMenu() {
  const trigger = Array.from(container.querySelectorAll("button"))
    .find((button) => (button.getAttribute("aria-label") ?? "").startsWith("Change view"));
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger!.click();
  });
}

describe("TaskViewsMenu with saved views", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("names the button after the open saved view, not its id", async () => {
    await render(
      <TaskViewsMenu
        value={"saved:v1" as TaskSurfaceViewKey}
        onChange={() => {}}
        savedViews={[savedView("v1", "Ready to start")]}
      />,
    );

    const trigger = container.querySelector("button");
    expect(trigger?.getAttribute("aria-label")).toBe("Change view — currently Ready to start");
    expect(trigger?.textContent).toContain("Ready to start");
    expect(trigger?.textContent).not.toContain("v1");
  });

  it("falls back to a neutral label when the saved view has not loaded", async () => {
    await render(
      <TaskViewsMenu value={"saved:v1" as TaskSurfaceViewKey} onChange={() => {}} savedViews={[]} />,
    );

    expect(container.querySelector("button")?.textContent).not.toContain("saved:");
  });

  it("lists saved views alongside the built-in ones and reports the chosen key", async () => {
    const onChange = vi.fn();
    await render(
      <TaskViewsMenu
        value="all"
        onChange={onChange}
        savedViews={[savedView("v1", "Ready to start"), savedView("v2", "Waiting on agents")]}
      />,
    );
    await openMenu();

    expect(text()).toContain("Saved views");
    expect(text()).toContain("Ready to start");
    expect(text()).toContain("All tasks");

    const item = findByText("Waiting on agents");
    expect(item).toBeTruthy();
    await act(async () => { item!.click(); });

    expect(onChange).toHaveBeenCalledWith("saved:v2");
  });

  it("offers starter views only while the user has none", async () => {
    const onAddStarterViews = vi.fn();
    await render(
      <TaskViewsMenu value="all" onChange={() => {}} savedViews={[]} onAddStarterViews={onAddStarterViews} />,
    );
    await openMenu();
    expect(text()).toContain("Add starter views");

    const add = findByText("Add starter views");
    await act(async () => { add!.click(); });
    expect(onAddStarterViews).toHaveBeenCalledTimes(1);
  });

  it("hides the starter offer once a view exists", async () => {
    await render(
      <TaskViewsMenu
        value="all"
        onChange={() => {}}
        savedViews={[savedView("v1", "Ready to start")]}
        onAddStarterViews={undefined}
      />,
    );
    await openMenu();

    expect(text()).not.toContain("Add starter views");
  });

  it("renders the built-in views unchanged when no saved views are passed", async () => {
    await render(<TaskViewsMenu value="mine" onChange={() => {}} badgeCount={3} />);
    await openMenu();

    expect(text()).toContain("My work");
    expect(text()).toContain("Organization");
    expect(text()).not.toContain("Saved views");
  });
});

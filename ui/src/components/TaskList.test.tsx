// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIssue } from "../../storybook/fixtures/paperclipData";
import { TaskList, type TaskListItem } from "./TaskList";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("./IssueRow", () => ({ IssueRow: ({ issue, leadingControl }: { issue: { id: string; title: string }; leadingControl?: ReactNode }) =>
  <div data-issue-row-details={issue.id}>{leadingControl}<button>{issue.title}</button></div> }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tasks = (count: number, parentId: string | null = null): TaskListItem[] => Array.from({ length: count }, (_, i) => ({
  issue: createIssue({ id: `task-${i}`, title: `Task ${i}`, parentId, createdAt: new Date(0), updatedAt: new Date(100_000 - i) }),
}));
describe("TaskList progressive rendering", () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const rows = () => host.querySelectorAll("[data-issue-row-details]");
  async function render(items: TaskListItem[]) {
    await act(async () => root.render(<TooltipProvider><TaskList items={items} /></TooltipProvider>));
  }
  async function more() {
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Show more tasks")!.click());
  }
  it("bounds the first render, reveals batches, and retains mounted rows through enrichment and append", async () => {
    const items = tasks(400);
    await render(items);
    expect(rows()).toHaveLength(100);
    const first = rows()[0];
    await more();
    expect(rows()).toHaveLength(250);
    await render(items.map(item => ({ ...item, assignee: "New name" })));
    expect(rows()).toHaveLength(250);
    expect(rows()[0]).toBe(first);
    await render(tasks(450));
    expect(rows()).toHaveLength(250);
    await more(); await more();
    expect(rows()).toHaveLength(450);
    expect(host.textContent).not.toContain("Show more tasks");
  });
  it("uses one budget across a large expanded tree, preserving its disclosure and parent", async () => {
    const parent = { issue: createIssue({ id: "root", title: "Root", parentId: null }) };
    await render([parent, ...tasks(220, "root")]);
    expect(rows()).toHaveLength(100);
    expect(rows()[0].getAttribute("data-issue-row-details")).toBe("root");
    const collapse = host.querySelector<HTMLButtonElement>('button[aria-label="Collapse Root"]')!;
    await act(async () => collapse.click());
    expect(rows()).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Expand Root"]')!.click());
    expect(rows()).toHaveLength(100);
    await more();
    expect(rows()).toHaveLength(221);
  });
  it("reveals more when the sentinel intersects and resets the budget for a different result set", async () => {
    let intersect!: (entries: { isIntersecting: boolean }[]) => void;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {} disconnect() {}
    });
    await render(tasks(300));
    expect(rows()).toHaveLength(100);
    await act(async () => intersect([{ isIntersecting: true }]));
    expect(rows()).toHaveLength(250);
    await render(tasks(300).map(item => ({ issue: { ...item.issue, id: `other-${item.issue.id}` } })));
    expect(rows()).toHaveLength(100);
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, Project } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDetailTasksPanel } from "./TaskDetailTasksPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> }));
vi.mock("@/components/IssueRow", () => ({ IssueRow: ({ issue }: { issue: Issue }) => <span data-task-id={issue.id}>{issue.title}</span> }));
const task = (id: string, overrides: Partial<Issue> = {}) => ({ id, title: id, status: "todo", projectId: null, ...overrides }) as Issue;
const project = { id: "project-1", name: "Board UI", urlKey: "board-ui" } as Project;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root?.unmount()); container?.remove(); });
function render(props: React.ComponentProps<typeof TaskDetailTasksPanel>) {
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<TaskDetailTasksPanel {...props} />));
}

describe("TaskDetailTasksPanel", () => {
  it("keeps subtask membership separate from creation membership, including overlap", () => {
    const manual = task("manual-child");
    const overlap = task("created-child", { projectId: project.id });
    const followup = task("other-parent", { parentId: "elsewhere", projectId: project.id });
    render({ subtasks: [manual, overlap], createdTasks: [overlap, followup], projects: [project] });
    expect(container.querySelectorAll('[data-task-id="created-child"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-task-id="manual-child"]')).toHaveLength(1);
    const group = container.querySelector('section[aria-label="Board UI"]')!;
    expect(group.textContent).toContain("other-parent");
    expect(group.textContent).not.toContain("manual-child");
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  });

  it("hides absent subtasks and puts unowned tasks under No project without a link or progress", () => {
    render({ subtasks: [], createdTasks: [task("unowned", { project: project })], projects: [project] });
    expect(container.textContent).not.toContain("Subtasks");
    expect(container.querySelector('section[aria-label="No project"]')).not.toBeNull();
    expect(container.querySelectorAll('a, [role="progressbar"]')).toHaveLength(0);
  });

  it("sorts unfinished before completed work, deduplicates within groups, and folds independently", () => {
    const done = task("done", { status: "done", projectId: project.id });
    const unfinished = task("unfinished", { projectId: project.id });
    render({ subtasks: [task("child")], createdTasks: [done, unfinished, done], projects: [project] });
    const group = container.querySelector('section[aria-label="Board UI"]')!;
    expect([...group.querySelectorAll('[data-task-id]')].map((row) => row.getAttribute("data-task-id"))).toEqual(["unfinished", "done"]);
    expect(group.querySelector('a')?.getAttribute("href")).toBe("/projects/board-ui/issues");
    act(() => (group.querySelector('button') as HTMLButtonElement).click());
    expect(group.querySelector('[data-task-id]')).toBeNull();
    expect(container.querySelector('[data-task-id="child"]')).not.toBeNull();
  });

  it("surfaces query failures without hiding available subtasks", () => {
    const retry = vi.fn();
    render({ subtasks: [task("child")], createdTasks: [], projects: [], hasError: true, onRetry: retry });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load all tasks");
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === "Retry")!.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-task-id="child"]')).not.toBeNull();
  });
});

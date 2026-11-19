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

const ancestors = [
  { id: "parent", identifier: "PAP-2", title: "Immediate parent", status: "in_progress" },
  { id: "root", identifier: null, title: "Root task", status: "done" },
] as NonNullable<Issue["ancestors"]>;

describe("TaskDetailTasksPanel", () => {
  it("shows ancestors root first above subtasks and folds them independently", () => {
    render({ ancestors, subtasks: [task("child")], createdTasks: [], projects: [] });
    const group = container.querySelector('section[aria-label="Ancestors"]')!;
    expect([...group.querySelectorAll('a')].map((link) => link.getAttribute("href"))).toEqual(["/issues/root", "/issues/PAP-2"]);
    expect(group.textContent).toContain("Immediate parent");
    expect(group.querySelector('[role="progressbar"]')).toBeNull();
    expect([...container.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(["Ancestors", "Subtasks"]);
    expect(ancestors.map((ancestor) => ancestor.id)).toEqual(["parent", "root"]);
    act(() => (group.querySelector('button') as HTMLButtonElement).click());
    expect(group.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-task-id="child"]')).not.toBeNull();
  });

  it("renders locked ancestors as non-interactive chips alongside readable ancestors", () => {
    render({ ancestors: [{ id: "private-parent", identifier: "PAP-99", locked: true }, ancestors[1]] as unknown as Issue["ancestors"], subtasks: [], createdTasks: [], projects: [] });
    const group = container.querySelector('section[aria-label="Ancestors"]')!;
    expect(group.querySelector('[data-testid="locked-issue-chip"]')?.textContent).toContain("PAP-99");
    expect([...group.querySelectorAll('a')].map(link => link.getAttribute("href"))).toEqual(["/issues/root"]);
    expect(group.textContent).not.toContain("undefined");
  });

  it("keeps ancestor-only tasks navigable instead of showing an empty state", () => {
    render({ ancestors, subtasks: [], createdTasks: [], projects: [] });
    expect(container.querySelectorAll('a')).toHaveLength(2);
    expect(container.textContent).not.toContain("No tasks yet.");
  });

  it("hides the ancestor section for root tasks and preserves the empty state", () => {
    render({ subtasks: [], createdTasks: [], projects: [] });
    expect(container.querySelector('section[aria-label="Ancestors"]')).toBeNull();
    expect(container.textContent).toContain("No tasks yet.");
  });

  it("shows overlapping next actions and other subtasks only in the subtask section", () => {
    const manual = task("manual-child");
    const overlap = task("created-child", { projectId: project.id, status: "in_progress" });
    const completed = task("completed-child", { projectId: project.id, status: "done" });
    const followup = task("other-parent", { parentId: "elsewhere", projectId: project.id });
    render({ subtasks: [manual, overlap, completed], createdTasks: [{ ...overlap }, followup, { ...completed }], projects: [project] });
    expect(container.querySelectorAll('[data-task-id="created-child"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-task-id="completed-child"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-task-id="manual-child"]')).toHaveLength(1);
    const group = container.querySelector('section[aria-label="Board UI"]')!;
    expect(group.textContent).toContain("other-parent");
    expect(group.textContent).not.toContain("created-child");
    expect(group.textContent).not.toContain("completed-child");
    expect(group.textContent).not.toContain("manual-child");
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("33");
    act(() => (container.querySelector('section[aria-label="Subtasks"] button') as HTMLButtonElement).click());
    expect(container.querySelector('[data-task-id="created-child"]')).toBeNull();
    expect(container.querySelector('[data-task-id="other-parent"]')).not.toBeNull();
  });

  it.each([project.id, null])("hides a project group when all its tasks are subtasks (project %s)", (projectId) => {
    const child = task("child", { projectId });
    render({ subtasks: [child, { ...child }], createdTasks: [{ ...child }, child], projects: [project] });
    expect(container.querySelectorAll('[data-task-id="child"]')).toHaveLength(1);
    expect([...container.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(["Subtasks"]);
    expect(container.textContent).not.toContain("No tasks yet.");
  });

  it("does not repeat a subtask's root blocker in a project group", () => {
    const blocker = task("blocker", { identifier: "PAP-11", projectId: project.id });
    const child = task("child", {
      status: "blocked",
      blockerAttention: {
        state: "needs_attention",
        reason: "attention_required",
        unresolvedBlockerCount: 1,
        coveredBlockerCount: 0,
        stalledBlockerCount: 0,
        attentionBlockerCount: 1,
        sampleBlockerIdentifier: blocker.identifier,
        sampleStalledBlockerIdentifier: null,
        terminalBlocker: blocker,
      },
    });
    render({ subtasks: [child], createdTasks: [blocker], projects: [project] });
    expect(container.querySelectorAll('a[href="/issues/PAP-11"]')).toHaveLength(1);
    expect(container.querySelector('[data-task-id="blocker"]')).toBeNull();
    expect(container.querySelector('section[aria-label="Board UI"]')).toBeNull();
  });

  it("keeps task and project lookups linear for large overlapping lists", () => {
    let lookups = 0;
    const readId = (id: string) => {
      if (++lookups > 12000) throw new Error("Too many task and project lookups");
      return id;
    };
    const projects = Array.from({ length: 120 }, (_, index) => ({
      ...project, get id() { return readId(`project-${index}`); }, name: `Project ${index}`,
    }));
    const tasks = Array.from({ length: 800 }, (_, index) => task(`task-${index}`, {
      projectId: `project-${index % projects.length}`,
    }));
    for (let index = 0; index < tasks.length; index++) {
      Object.defineProperty(tasks[index], "id", { get: () => readId(`task-${index}`) });
    }
    render({ subtasks: tasks.slice(0, 600), createdTasks: tasks, projects });
    const rows = [...container.querySelectorAll('[data-task-id]')];
    expect(rows).toHaveLength(800);
    expect(new Set(rows.map((row) => row.getAttribute("data-task-id"))).size).toBe(800);
    expect(lookups).toBeLessThan(12000);
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

  it("shows the access-checked creation source even when the task has no parent", () => {
    render({
      createdFrom: {
        issue: { id: "source", identifier: "PAP-168", title: "Verify Tailscale fix", status: "in_progress" },
        run: { id: "run-1", agentId: "qa" },
        agent: { id: "qa", name: "Paperclip QA" },
      },
      subtasks: [], createdTasks: [], projects: [],
    });
    const group = container.querySelector('section[aria-label="Created from"]')!;
    expect(group).not.toBeNull();
    const note = group.querySelector('[data-testid="issue-created-from"]')!;
    expect(note.textContent).toContain("Created from");
    expect(note.textContent).toContain("PAP-168 Verify Tailscale fix");
    expect(note.textContent).toContain("by Paperclip QA");
    expect(note.querySelector('a')?.getAttribute("href")).toBe("/issues/PAP-168");
    expect(container.querySelector('section[aria-label="Ancestors"]')).toBeNull();
    expect(container.textContent).not.toContain("No tasks yet.");
  });

  it("omits the creation source when the viewer may not see it", () => {
    render({ createdFrom: null, subtasks: [], createdTasks: [], projects: [] });
    expect(container.querySelector('section[aria-label="Created from"]')).toBeNull();
    expect(container.textContent).toContain("No tasks yet.");
  });

  it("does not repeat the creation source or ancestors in project groups", () => {
    render({
      ancestors,
      createdFrom: {
        issue: ancestors[0],
        run: null,
        agent: null,
      },
      subtasks: [],
      createdTasks: [task("parent", { projectId: project.id }), task("root"), task("followup", { projectId: project.id })],
      projects: [project],
    });
    expect(container.querySelectorAll('a[href="/issues/PAP-2"]')).toHaveLength(1);
    expect(container.querySelectorAll('a[href="/issues/root"]')).toHaveLength(1);
    expect(container.querySelector('[data-task-id="parent"]')).toBeNull();
    expect(container.querySelector('[data-task-id="root"]')).toBeNull();
    expect(container.querySelector('[data-task-id="followup"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="No project"]')).toBeNull();
  });
});

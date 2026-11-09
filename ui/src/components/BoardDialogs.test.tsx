// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardDialogs } from "./BoardDialogs";

const state = vi.hoisted(() => ({ newIssueOpen: false, newProjectOpen: false, newGoalOpen: false, newAgentOpen: false }));
vi.mock("../context/DialogContext", () => ({ useDialogState: () => state, useDialogActions: () => ({ closeNewIssue: vi.fn(), closeNewProject: vi.fn(), closeNewGoal: vi.fn(), closeNewAgent: vi.fn() }) }));
vi.mock("./NewIssueDialog", () => ({ NewIssueDialog: () => <input aria-label="Task draft" /> }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => <div>Project dialog</div> }));
vi.mock("./NewGoalDialog", () => ({ NewGoalDialog: () => <div>Goal dialog</div> }));
vi.mock("./NewAgentDialog", () => ({ NewAgentDialog: () => <div>Agent dialog</div> }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(state, { newIssueOpen: false, newProjectOpen: false, newGoalOpen: false, newAgentOpen: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() { await act(async () => { root.render(<BoardDialogs />); }); }
it("renders the task form on the first open without an asynchronous loading frame", () => {
  act(() => flushSync(() => root.render(<BoardDialogs />)));
  state.newIssueOpen = true;
  act(() => {
    flushSync(() => root.render(<BoardDialogs />));
    expect(container.querySelector('[aria-label="Task draft"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Loading new task");
  });
});
it("leaves unopened dialog trees unmounted", async () => {
  await render();
  expect(container.innerHTML).toBe("");
});
it("loads a requested dialog and retains its draft across close and reopen", async () => {
  await render();
  state.newIssueOpen = true;
  await render();
  const draft = container.querySelector("input")!;
  expect(draft).not.toBeNull();
  draft.value = "Keep my draft";
  expect(container.textContent).not.toContain("Project dialog");
  state.newIssueOpen = false;
  await render();
  state.newIssueOpen = true;
  await render();
  expect(container.querySelector("input")).toBe(draft);
  expect(container.querySelector("input")?.value).toBe("Keep my draft");
});

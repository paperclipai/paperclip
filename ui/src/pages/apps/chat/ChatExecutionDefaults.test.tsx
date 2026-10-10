// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatExecutionDefaults } from "./ChatExecutionDefaults";
const mocks = vi.hoisted(() => ({ projects: vi.fn(), workspaces: vi.fn(), save: vi.fn() }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: mocks.projects } }));
vi.mock("@/api/execution-workspaces", () => ({ executionWorkspacesApi: { listSummaries: mocks.workspaces } }));
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); mocks.projects.mockResolvedValue([]); mocks.workspaces.mockResolvedValue([]); mocks.save.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><ChatExecutionDefaults companyId="company" value={{ projectId: null }} resource onSave={mocks.save} /></QueryClientProvider>));
  await vi.waitFor(() => expect(container.querySelectorAll("select")[1].disabled).toBe(false));
}
async function choose(value: string) {
  await act(async () => { const select = container.querySelectorAll("select")[1]; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function save() {
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
it("lets a destination clear inherited workspace independently of project", async () => {
  await render(); await choose("clear"); await save();
  expect(mocks.save).toHaveBeenCalledWith({ projectId: null, workspace: null });
  expect(container.textContent).toContain("Saved for new tasks.");
});
it("keeps edits visible after a save failure and permits retry", async () => {
  mocks.save.mockRejectedValueOnce(new Error("Workspace access was revoked"));
  await render(); await choose("task"); await save();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Workspace access was revoked");
  expect(container.querySelectorAll("select")[1].value).toBe("task");
  await save();
  expect(mocks.save).toHaveBeenLastCalledWith({ projectId: null, workspace: { kind: "task_directory" } });
  expect(container.textContent).toContain("Saved for new tasks.");
});

it("offers and saves an idle workspace from the shared task selection filter", async () => {
  mocks.workspaces.mockResolvedValue([
    { id: "active-workspace", name: "Active files", status: "active", closedAt: null },
    { id: "idle-workspace", name: "Idle files", status: "idle", closedAt: null },
  ]);
  await render();
  expect(mocks.workspaces).toHaveBeenCalledWith("company", { selectableForTask: true });
  const options = [...container.querySelectorAll("select")[1].options].map((option) => option.value);
  expect(options).toContain("existing:active-workspace");
  expect(options).toContain("existing:idle-workspace");
  await choose("existing:idle-workspace");
  await save();
  expect(mocks.save).toHaveBeenCalledWith({
    projectId: null,
    workspace: { kind: "existing", workspaceId: "idle-workspace" },
  });
});

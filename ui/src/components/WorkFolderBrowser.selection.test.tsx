// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkFolderBrowser } from "./WorkFolderBrowser";

const api = vi.hoisted(() => ({ list: vi.fn(), sync: vi.fn(), operation: vi.fn() }));
vi.mock("@/api/work-folders", () => ({ workFoldersApi: api }));
const owner = { companyId: "company", scope: "task" as const, ownerId: "task" };
const a = { id: "a", path: "a.txt", kind: "file" };
const b = { id: "b", path: "b.txt", kind: "file" };
let active = [a, b];
let deleted: typeof active = [];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function click(element: HTMLElement) {
  await act(async () => { element.focus(); element.click(); });
  await settle();
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes(text));
const checkbox = (path: string) => container.querySelector<HTMLInputElement>(`[data-file-tree-path="${path}"] input`)!;
beforeEach(async () => {
  active = [a, b]; deleted = [];
  api.list.mockImplementation(async (_owner, trash) => ({ files: [...(trash ? deleted : active)] }));
  api.sync.mockResolvedValue([]);
  api.operation.mockImplementation(async (_owner, operation) => {
    if (operation.action === "delete") {
      const matches = (file: typeof a) => file.path === operation.path || file.path.startsWith(`${operation.path}/`);
      deleted.push(...active.filter(matches));
      active = active.filter((file) => !matches(file));
    } else {
      active.push(...deleted.filter((file) => file.id === operation.fileId));
      deleted = deleted.filter((file) => file.id !== operation.fileId);
    }
    return { applied: true };
  });
  container = document.createElement("div"); document.body.append(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><WorkFolderBrowser owner={owner} readOnly allowTrashActions /></TooltipProvider></QueryClientProvider>));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks();
});
describe("cached file selection and retained trash", () => {
  it("moves an empty directory to trash when its checkbox is selected", async () => {
    active = [{ id: "empty", path: "empty", kind: "directory" }];
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    await click(checkbox("empty"));
    expect(checkbox("empty").checked).toBe(true);
    await click(button("Move 1 item to trash")!);
    expect(active).toEqual([]);
    expect(deleted.map((file) => file.path)).toEqual(["empty"]);
  });
  it("deletes a selected directory once, including all its children", async () => {
    active = [{ id: "dir", path: "docs", kind: "directory" }, { ...a, path: "docs/a.txt" }];
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    await click(checkbox("docs"));
    await click(button("Move 1 item to trash")!);
    expect(active).toEqual([]);
    expect(api.operation).toHaveBeenCalledTimes(1);
    expect(api.operation).toHaveBeenCalledWith(owner, { action: "delete", path: "docs" }, expect.any(String));
  });
  it("does not recursively delete a parent after a child is unchecked", async () => {
    active = [{ id: "dir", path: "docs", kind: "directory" }, { ...a, path: "docs/a.txt" }, { ...b, path: "docs/b.txt" }];
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    await click(container.querySelector<HTMLElement>('[data-file-tree-path="docs"]')!);
    await click(checkbox("docs"));
    await click(checkbox("docs/a.txt"));
    expect(checkbox("docs").checked).toBe(false);
    expect(checkbox("docs").indeterminate).toBe(true);
    await click(button("Move 1 file to trash")!);
    expect(active.map((file) => file.path)).toEqual(["docs", "docs/a.txt"]);
    expect(api.operation).toHaveBeenCalledWith(owner, { action: "delete", path: "docs/b.txt" }, expect.any(String));
  });
  it("only shows trash action for checked files and restores from the Trash tab", async () => {
    expect(button("to trash")).toBeUndefined();
    await click(checkbox("a.txt"));
    expect(checkbox("a.txt").checked).toBe(true);
    expect(button("Move 1 file to trash")).toBeDefined();
    await click(button("Move 1 file to trash")!);
    expect(active).toEqual([b]);
    expect(button("to trash")).toBeUndefined();
    await click(button("Trash")!);
    expect(container.textContent).toContain("a.txt");
    expect(button("Purge")).toBeUndefined();
    await click(button("Restore")!);
    await click(button("Files")!);
    expect(checkbox("a.txt")).not.toBeNull();
    expect(deleted).toEqual([]);
  });
  it.each([["a.txt", "b.txt"], ["b.txt", "a.txt"]])("refreshes partial successes when selected in order %s, %s", async (first, second) => {
    const operate = api.operation.getMockImplementation()!;
    api.operation.mockImplementation(async (target, operation) => {
      if (operation.path === "b.txt") throw new Error("Storage unavailable");
      return operate(target, operation);
    });
    await click(checkbox(first)); await click(checkbox(second));
    await click(button("Move 2 files to trash")!);
    expect(checkbox("a.txt")).toBeNull();
    expect(checkbox("b.txt").checked).toBe(true);
    expect(container.textContent).toContain("Storage unavailable");
    expect(button("Move 1 file to trash")).toBeDefined();
    expect(deleted).toEqual([a]);
  });
});

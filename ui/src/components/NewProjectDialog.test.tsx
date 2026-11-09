// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PROJECT_COLORS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsApi } from "../api/projects";
import { getLastProjectId } from "../lib/recent-projects";
import { NewProjectForm } from "./NewProjectDialog";

vi.mock("../api/projects", () => ({ projectsApi: { create: vi.fn() } }));
vi.mock("./ProjectRepositoryInput", () => ({
  ProjectRepositoryInput: () => null,
  repositoryOptionsKey: (companyId: string) => ["repositories", companyId],
}));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({ ConnectionSetupFlow: () => null }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(projectsApi.create).mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

describe("new project colors", () => {
  it("previews a palette color, keeps it through a retry, and remembers the created project", async () => {
    vi.mocked(projectsApi.create)
      .mockRejectedValueOnce(new Error("Try again"))
      .mockResolvedValueOnce({ id: "project-created" } as Awaited<ReturnType<typeof projectsApi.create>>);
    const onClose = vi.fn();
    act(() => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <NewProjectForm companyId="company-1" onClose={onClose} />
    </QueryClientProvider>));
    const previewColor = container.querySelector<HTMLElement>('span[style]')!.style.backgroundColor;
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Colorful project");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Try again");
    const firstColor = vi.mocked(projectsApi.create).mock.calls[0][1].color;
    expect(PROJECT_COLORS).toContain(firstColor);
    const expected = document.createElement("span");
    expected.style.backgroundColor = String(firstColor);
    expect(previewColor).toBe(expected.style.backgroundColor);
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(vi.mocked(projectsApi.create).mock.calls[1][1]).toEqual({ name: "Colorful project", color: firstColor, status: "planned", repositoryIds: [] });
    expect(getLastProjectId("company-1")).toBe("project-created");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { useProjectCreatedItems } from "./useProjectCreatedItems";

vi.mock("@/api/projects", () => ({ projectsApi: { get: vi.fn() } }));
const receipt = {
  id: "receipt",
  companyId: "company",
  action: "project.created",
  entityType: "project",
  entityId: "project",
  createdAt: "2026-09-11T12:00:00Z",
  details: {
    name: "Launch",
    repositories: [
      { id: "repo", name: "Original", url: "https://github.com/org/app" },
    ],
  },
} as unknown as ActivityEvent;
const events = [receipt];
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function Fixture({ activity = events }: { activity?: ActivityEvent[] }) {
  const items = useProjectCreatedItems(activity, "company");
  return <pre>{JSON.stringify(items)}</pre>;
}
function render(activity = events) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Fixture activity={activity} />
      </QueryClientProvider>,
    ),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

describe("shared project creation card queries", () => {
  it("refreshes repositories through existing project invalidation", async () => {
    const project = {
      id: "project",
      companyId: "company",
      workspaces: [
        { id: "first", name: "App", repoUrl: "https://github.com/org/app" },
      ],
    } as Project;
    vi.mocked(projectsApi.get).mockResolvedValue(project);
    render();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('"name":"App"'),
    );
    expect(projectsApi.get).toHaveBeenCalledWith("project", "company");
    vi.mocked(projectsApi.get).mockResolvedValue({
      ...project,
      workspaces: [
        ...project.workspaces,
        {
          ...project.workspaces[0],
          id: "second",
          name: "Docs",
          repoUrl: "https://github.com/org/docs",
        },
      ],
    });
    await act(async () => {
      await client.invalidateQueries({
        queryKey: queryKeys.projects.detail("project"),
      });
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("https://github.com/org/docs"),
    );
    expect(JSON.parse(container.textContent!)).toHaveLength(1);
  });
  it("retains the creation receipt if the project is inaccessible", async () => {
    vi.mocked(projectsApi.get).mockRejectedValue(new Error("Not found"));
    render();
    await vi.waitFor(() =>
      expect(
        client.getQueryState(queryKeys.projects.detail("project"))?.status,
      ).toBe("error"),
    );
    expect(container.textContent).toContain('"name":"Original"');
    expect(projectsApi.get).toHaveBeenCalledTimes(1);
  });
  it("does not query projects or invent creation cards without receipts", () => {
    render([]);
    expect(projectsApi.get).not.toHaveBeenCalled();
    expect(container.textContent).toBe("[]");
  });
});

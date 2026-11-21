import { describe, expect, it, vi } from "vitest";

const mockProjects = vi.hoisted(() => ({
  getById: vi.fn(),
  listWorkspaces: vi.fn(),
}));

vi.mock("../services/projects.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/projects.js")>()),
  projectService: () => mockProjects,
}));

import { buildHostServices } from "../services/plugin-host-services.js";

function workspaceRow(overrides: Record<string, unknown>) {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "workspace-1",
    projectId: "project-1",
    name: "main",
    cwd: null,
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    isPrimary: true,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function listWorkspaces(rows: ReturnType<typeof workspaceRow>[]) {
  mockProjects.getById.mockResolvedValue({
    id: "project-1",
    companyId: "company-1",
    codebase: { effectiveLocalFolder: "/managed/project-1" },
  });
  mockProjects.listWorkspaces.mockResolvedValue(rows);
  const eventBus = {
    forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
  };
  const services = buildHostServices({} as never, "plugin-record-id", "daytona", eventBus as never);
  return services.projects.listWorkspaces({ companyId: "company-1", projectId: "project-1" });
}

describe("plugin host listWorkspaces", () => {
  it("resolves a managed primary workspace to the project's effective local folder", async () => {
    const [workspace] = await listWorkspaces([workspaceRow({})]);
    expect(workspace?.path).toBe("/managed/project-1");
  });

  it("keeps an explicit cwd and leaves non-primary managed workspaces empty", async () => {
    const workspaces = await listWorkspaces([
      workspaceRow({ cwd: "/explicit/primary" }),
      workspaceRow({ id: "workspace-2", isPrimary: false }),
    ]);
    expect(workspaces.map((workspace) => workspace.path)).toEqual(["/explicit/primary", ""]);
  });
});

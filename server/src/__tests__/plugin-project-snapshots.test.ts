import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers, type HostServices } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import type { PluginCapability } from "@paperclipai/shared";

const companyId = "00000000-0000-4000-8000-000000000001";
const otherCompany = "00000000-0000-4000-8000-000000000002";
const first = "00000000-0000-4000-8000-000000000003";
const second = "00000000-0000-4000-8000-000000000004";
const capabilities: PluginCapability[] = ["projects.read", "project.workspaces.read", "projects.instance-secrets"];
const entityType = "project-settings";

function fixture(granted = capabilities) {
  const projects = new Map([first, second].map(id => [id, { id, companyId, archivedAt: null as Date | null }]));
  const entities = new Map([first, second].map(id => [id, { id, status: "ready" }]));
  const services = {
    projects: {
      get: vi.fn(async ({ projectId }: { projectId: string }) => structuredClone(projects.get(projectId) ?? null)),
      listWorkspaces: vi.fn(async ({ projectId }: { projectId: string }) => [{ projectId }]),
      getInstanceSecrets: vi.fn(async ({ projectId }: { projectId: string }) => ({ fixture: projectId })),
    },
    entities: { list: vi.fn(async ({ externalId }: { externalId: string }) => entities.has(externalId) ? [{ ...entities.get(externalId) }] : []) },
  };
  const handlers = createHostClientHandlers({ pluginId: "project-plugin", capabilities: granted, services: services as unknown as HostServices });
  return { services, projects, entities, read: (projectIds: string[], requestedCompany = companyId) => handlers["projects.readSnapshots"](
    { projectIds, companyId: requestedCompany, entityType }, { invocationScope: { companyId } },
  ) };
}

describe("plugin project snapshots", () => {
  it("returns the requested projects in order with only the plugin's company-scoped entity", async () => {
    const f = fixture();
    const result = await f.read([second, first]);
    expect(result.map(row => [row.projectId, row.workspaces[0].projectId, row.entity?.id, row.instanceSecrets.fixture]))
      .toEqual([[second, second, second, second], [first, first, first, first]]);
    expect(f.services.entities.list.mock.calls.map(([query]) => query)).toEqual([second, second, first, first].map(externalId => ({
      entityType, scopeKind: "company", scopeId: companyId, externalId, limit: 1,
    })));
  });

  it("requires each underlying capability and the invocation's company", async () => {
    for (const omitted of capabilities) {
      const f = fixture(capabilities.filter(capability => capability !== omitted));
      await expect(f.read([first])).rejects.toThrow("missing required capability");
      expect(f.services.projects.get).not.toHaveBeenCalled();
    }
    const f = fixture();
    await expect(f.read([first], otherCompany)).rejects.toThrow(/invocation.*company/i);
    await expect(f.read([first, first])).rejects.toThrow("Invalid project snapshot scope");
    expect(f.services.projects.get).not.toHaveBeenCalled();
  });

  it.each(["wrong company", "archived", "missing", "changed entity"])("rejects the whole batch for a %s project", async failure => {
    const f = fixture();
    if (failure === "wrong company") f.projects.set(second, { id: second, companyId: otherCompany, archivedAt: null });
    else if (failure === "archived") f.projects.get(second)!.archivedAt = new Date();
    else if (failure === "missing") f.projects.delete(second);
    else f.services.projects.listWorkspaces.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === second) f.entities.get(second)!.status = "changed";
      return [{ projectId }];
    });
    await expect(f.read([first, second])).rejects.toThrow(/Project snapshot (unavailable|changed during read)/);
    if (failure !== "changed entity") {
      expect(f.services.projects.getInstanceSecrets).not.toHaveBeenCalledWith({ companyId, projectId: second });
    }
  });
});

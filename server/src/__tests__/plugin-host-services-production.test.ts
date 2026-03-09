import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";
import { companyService } from "../services/companies.js";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";
import { projectService } from "../services/projects.js";
import type { Db } from "@paperclipai/db";
import type { PluginEventBus } from "../services/plugin-event-bus.js";

vi.mock("../services/companies.js");
vi.mock("../services/issues.js");
vi.mock("../services/activity-log.js");
vi.mock("../services/plugin-registry.js");
vi.mock("../services/plugin-state-store.js");
vi.mock("../services/plugin-secrets-handler.js");
vi.mock("../services/agents.js");
vi.mock("../services/projects.js");
vi.mock("../services/goals.js");
vi.mock("../services/activity.js");
vi.mock("../services/costs.js");
vi.mock("../services/assets.js");

describe("buildHostServices production implementation", () => {
  let db: Db;
  let eventBus: PluginEventBus;
  const pluginId = "plugin-uuid";
  const pluginKey = "test.plugin";

  beforeEach(() => {
    db = {} as Db;
    eventBus = {
      forPlugin: vi.fn().mockReturnValue({
        emit: vi.fn(),
      }),
    } as any;
    vi.clearAllMocks();
  });

  it("delegates companies.list to companyService", async () => {
    const mockList = vi.fn().mockResolvedValue([{ id: "c1", name: "Acme" }]);
    (companyService as any).mockReturnValue({ list: mockList });

    const services = buildHostServices(db, pluginId, pluginKey, eventBus);
    const result = await services.companies.list({});

    expect(mockList).toHaveBeenCalled();
    expect(result).toEqual([{ id: "c1", name: "Acme" }]);
  });

  it("delegates issues.create to issueService and validates companyId", async () => {
    const mockCreate = vi.fn().mockResolvedValue({ id: "i1", title: "New Issue" });
    (issueService as any).mockReturnValue({ create: mockCreate });

    const services = buildHostServices(db, pluginId, pluginKey, eventBus);

    // Should fail without companyId
    await expect(services.issues.create({ title: "No Co" } as any))
      .rejects.toThrow("companyId is required");

    // Should succeed with companyId
    const result = await services.issues.create({ companyId: "c1", title: "With Co" });
    expect(mockCreate).toHaveBeenCalledWith("c1", { companyId: "c1", title: "With Co" });
    expect(result).toEqual({ id: "i1", title: "New Issue" });
  });

  it("delegates activity.log to logActivity", async () => {
    const services = buildHostServices(db, pluginId, pluginKey, eventBus);

    await services.activity.log({
      companyId: "c1",
      message: "Something happened",
      entityType: "issue",
      entityId: "i1",
      metadata: { foo: "bar" }
    });

    expect(logActivity).toHaveBeenCalledWith(db, {
      companyId: "c1",
      actorType: "plugin",
      actorId: pluginId,
      action: "Something happened",
      entityType: "issue",
      entityId: "i1",
      details: { foo: "bar" }
    });
  });

  it("ensures companyId for projects.list", async () => {
    const mockList = vi.fn().mockResolvedValue([]);
    (projectService as any).mockReturnValue({ list: mockList });

    const services = buildHostServices(db, pluginId, pluginKey, eventBus);
    await expect(services.projects.list({} as any)).rejects.toThrow("companyId is required");
  });

  it("hides cross-company projects from direct reads", async () => {
    const mockGetById = vi.fn().mockResolvedValue({
      id: "p1",
      companyId: "c2",
      name: "Other company project",
    });
    const mockListWorkspaces = vi.fn().mockResolvedValue([{ id: "w1" }]);
    const mockGetPrimaryWorkspace = vi.fn().mockResolvedValue({ id: "w1" });
    (projectService as any).mockReturnValue({
      getById: mockGetById,
      listWorkspaces: mockListWorkspaces,
      getPrimaryWorkspace: mockGetPrimaryWorkspace,
    });

    const services = buildHostServices(db, pluginId, pluginKey, eventBus);

    await expect(
      services.projects.get({ projectId: "p1", companyId: "c1" }),
    ).resolves.toBeNull();
    await expect(
      services.projects.listWorkspaces({ projectId: "p1", companyId: "c1" }),
    ).resolves.toEqual([]);
    await expect(
      services.projects.getPrimaryWorkspace({ projectId: "p1", companyId: "c1" }),
    ).resolves.toBeNull();
    expect(mockListWorkspaces).not.toHaveBeenCalled();
    expect(mockGetPrimaryWorkspace).not.toHaveBeenCalled();
  });

  it("blocks cross-company issue mutations and hides comment reads", async () => {
    const mockGetById = vi.fn().mockResolvedValue({
      id: "i1",
      companyId: "c2",
      title: "Other company issue",
    });
    const mockUpdate = vi.fn();
    const mockListComments = vi.fn();
    const mockAddComment = vi.fn();
    (issueService as any).mockReturnValue({
      getById: mockGetById,
      update: mockUpdate,
      listComments: mockListComments,
      addComment: mockAddComment,
    });

    const services = buildHostServices(db, pluginId, pluginKey, eventBus);

    await expect(
      services.issues.get({ issueId: "i1", companyId: "c1" }),
    ).resolves.toBeNull();
    await expect(
      services.issues.listComments({ issueId: "i1", companyId: "c1" }),
    ).resolves.toEqual([]);
    await expect(
      services.issues.update({ issueId: "i1", patch: { title: "Nope" }, companyId: "c1" }),
    ).rejects.toThrow("Issue not found");
    await expect(
      services.issues.createComment({ issueId: "i1", body: "Hello", companyId: "c1" }),
    ).rejects.toThrow("Issue not found");
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockListComments).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});

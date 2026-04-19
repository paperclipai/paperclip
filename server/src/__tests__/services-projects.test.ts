import { describe, expect, it, vi } from "vitest";
import { projectService, resolveProjectNameForUniqueShortname } from "../services/projects.js";

describe("services/projects.ts", () => {
  it("resolves a unique project name for shortname collisions", () => {
    const name = resolveProjectNameForUniqueShortname(
      "Growth Board",
      [
        { id: "p1", name: "Growth Board" },
        { id: "p2", name: "Growth Board 2" },
      ],
      {},
    );
    expect(name).toBe("Growth Board 3");
  });
  it("does not suffix non-ascii project names", () => {
    const name = resolveProjectNameForUniqueShortname("增长项目", [
      { id: "p1", name: "增长项目" },
    ]);
    expect(name).toBe("增长项目");
  });

  it("resolves a project by UUID reference in the same company", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { id: projectId, companyId: "company-1", name: "Growth Board" },
          ]),
        })),
      })),
    };
    const service = projectService(db as any);

    const resolved = await service.resolveByReference("company-1", projectId);
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.project).toMatchObject({
      id: projectId,
      companyId: "company-1",
      urlKey: "growth-board",
    });
  });

  it("flags ambiguous references when multiple projects share a slug", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([
            { id: "p1", companyId: "company-1", name: "Growth Board" },
            { id: "p2", companyId: "company-1", name: "Growth Board" },
          ]),
        })),
      })),
    };
    const service = projectService(db as any);

    const resolved = await service.resolveByReference("company-1", "growth-board");
    expect(resolved).toEqual({
      project: null,
      ambiguous: true,
    });
  });
});


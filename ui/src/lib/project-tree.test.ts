import { describe, expect, it } from "vitest";
import {
  buildProjectTree,
  getActiveDescendants,
  getDescendantIds,
  getParentTargetAvailability,
  getProjectDepth,
  getSubtreeHeight,
} from "./project-tree";

type ProjectFixture = {
  id: string;
  name: string;
  parentProjectId: string | null;
  archivedAt: string | null;
};

function project(id: string, parentProjectId: string | null = null, archivedAt: string | null = null): ProjectFixture {
  return { id, name: id, parentProjectId, archivedAt };
}

const projects = [project("root"), project("child", "root"), project("grandchild", "child")];

describe("project tree utilities", () => {
  it("builds a three-level tree and ignores archived rows", () => {
    const tree = buildProjectTree([...projects, project("archived", null, "2026-01-01")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].project.id).toBe("root");
    expect(tree[0].children[0].project.id).toBe("child");
    expect(tree[0].children[0].children[0].project.id).toBe("grandchild");
  });

  it("preserves caller order for roots and siblings", () => {
    const tree = buildProjectTree([
      project("root-z"),
      project("child-z", "root-z"),
      project("child-a", "root-z"),
      project("root-a"),
    ]);

    expect(tree.map((node) => node.project.id)).toEqual(["root-z", "root-a"]);
    expect(tree[0].children.map((node) => node.project.id)).toEqual(["child-z", "child-a"]);
  });

  it("calculates descendants, depth, and subtree height", () => {
    expect([...getDescendantIds(projects, "root")]).toEqual(["child", "grandchild"]);
    expect(getProjectDepth(projects, "grandchild")).toBe(3);
    expect(getSubtreeHeight(projects, "root")).toBe(3);
  });

  it("disables self, descendants, archived targets, and moves beyond depth three", () => {
    expect(getParentTargetAvailability(projects, "child", "child").reason).toMatch(/own parent/);
    expect(getParentTargetAvailability(projects, "root", "grandchild").reason).toMatch(/descendants/);

    const archived = [...projects, project("archived", null, "2026-01-01")];
    expect(getParentTargetAvailability(archived, "child", "archived").reason).toMatch(/Archived/);

    const wide = [...projects, project("leaf"), project("second", "grandchild")];
    expect(getParentTargetAvailability(wide, "leaf", "grandchild").reason).toMatch(/3-level/);
  });

  it("allows detaching and valid parent moves while finding active descendants", () => {
    expect(getParentTargetAvailability(projects, "grandchild", "root")).toEqual({ disabled: false, reason: null });
    expect(getActiveDescendants([...projects, project("old", "root", "2026-01-01")], "root").map((item) => item.id))
      .toEqual(["child", "grandchild"]);
  });
});

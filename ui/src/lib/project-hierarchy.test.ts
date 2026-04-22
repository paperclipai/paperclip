import { describe, expect, it } from "vitest";
import {
  buildProjectHierarchyEntries,
  projectAncestorNames,
  projectDescendantIds,
  projectHierarchyLabel,
  type ProjectHierarchyProject,
} from "./project-hierarchy";

function project(id: string, name: string, parentId: string | null = null): ProjectHierarchyProject {
  return { id, name, parentId };
}

describe("project hierarchy helpers", () => {
  it("flattens parents before children with depth and ancestor names", () => {
    const root = project("root", "Root");
    const child = project("child", "Child", "root");
    const grandchild = project("grandchild", "Grandchild", "child");
    const sibling = project("sibling", "Sibling");

    const entries = buildProjectHierarchyEntries([root, sibling, child, grandchild]);

    expect(entries.map((entry) => entry.project.id)).toEqual(["root", "child", "grandchild", "sibling"]);
    expect(entries.map((entry) => entry.depth)).toEqual([0, 1, 2, 0]);
    expect(entries[2]?.ancestorNames).toEqual(["Root", "Child"]);
  });

  it("keeps matching children visible with ancestor context when parents are filtered out", () => {
    const allProjects = [
      project("root", "Operations"),
      project("child", "Launch", "root"),
    ];

    const entries = buildProjectHierarchyEntries([allProjects[1]!], allProjects);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.project.name).toBe("Launch");
    expect(entries[0]?.depth).toBe(1);
    expect(projectHierarchyLabel(entries[0]!.project, allProjects)).toBe("Operations / Launch");
  });

  it("collects descendants for cycle-safe parent pickers", () => {
    const projects = [
      project("root", "Root"),
      project("child", "Child", "root"),
      project("grandchild", "Grandchild", "child"),
      project("other", "Other"),
    ];

    expect(projectDescendantIds("root", projects)).toEqual(new Set(["child", "grandchild"]));
    expect(projectAncestorNames(projects[2]!, projects)).toEqual(["Root", "Child"]);
  });
});

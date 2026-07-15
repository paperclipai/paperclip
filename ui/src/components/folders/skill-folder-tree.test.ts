import { describe, expect, it } from "vitest";
import type { FolderListItem } from "@paperclipai/shared";
import {
  buildSkillFolderTree,
  folderBreadcrumbTrail,
  isBundledFolder,
  isProjectsFolder,
  reservedRootLabel,
  subtreeFolderIds,
} from "./skill-folder-tree";

function folder(partial: Partial<FolderListItem> & { id: string; slug: string; path: string }): FolderListItem {
  return {
    companyId: "co",
    kind: "skill",
    parentId: null,
    name: partial.slug,
    systemKey: null,
    depth: 1,
    color: null,
    position: 0,
    itemCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

const folders: FolderListItem[] = [
  folder({ id: "my", slug: "my", path: "my", systemKey: "my", name: "my", position: 0 }),
  folder({ id: "mine", slug: "dotta", path: "my/dotta", parentId: "my", systemKey: "my:u1", depth: 2, position: 0 }),
  folder({ id: "eng", slug: "engineering", path: "engineering", name: "Engineering", position: 1 }),
  folder({ id: "eng-review", slug: "review", path: "engineering/review", parentId: "eng", depth: 2, name: "Review", position: 0 }),
  folder({ id: "proj", slug: "projects", path: "projects", systemKey: "projects", name: "projects", position: 2 }),
  folder({ id: "proj-a", slug: "acme", path: "projects/acme", parentId: "proj", systemKey: "project:a", depth: 2 }),
  folder({ id: "bundled", slug: "bundled", path: "bundled", systemKey: "bundled", name: "bundled", position: 3 }),
  folder({ id: "bundled-git", slug: "git", path: "bundled/git", parentId: "bundled", systemKey: "bundled:git", depth: 2 }),
];

describe("buildSkillFolderTree", () => {
  it("groups reserved roots and company folders in order", () => {
    const model = buildSkillFolderTree(folders);
    expect(model.my?.folder.id).toBe("my");
    expect(model.projects?.folder.id).toBe("proj");
    expect(model.bundled?.folder.id).toBe("bundled");
    expect(model.company.map((n) => n.folder.id)).toEqual(["eng"]);
    // Ordered roots: My → company → Projects → Bundled.
    expect(model.roots.map((n) => n.folder.id)).toEqual(["my", "eng", "proj", "bundled"]);
  });

  it("nests children under their parent", () => {
    const model = buildSkillFolderTree(folders);
    expect(model.my?.children.map((n) => n.folder.id)).toEqual(["mine"]);
    expect(model.company[0]?.children.map((n) => n.folder.id)).toEqual(["eng-review"]);
    expect(model.childrenById.get("bundled")?.map((n) => n.folder.id)).toEqual(["bundled-git"]);
  });
});

describe("subtreeFolderIds", () => {
  it("includes the folder and all descendants", () => {
    const model = buildSkillFolderTree(folders);
    expect([...subtreeFolderIds(model, "eng")].sort()).toEqual(["eng", "eng-review"]);
    expect([...subtreeFolderIds(model, "my")].sort()).toEqual(["mine", "my"]);
    expect([...subtreeFolderIds(model, "eng-review")]).toEqual(["eng-review"]);
  });
});

describe("folderBreadcrumbTrail", () => {
  it("walks from top-level root down to the target", () => {
    const model = buildSkillFolderTree(folders);
    expect(folderBreadcrumbTrail(model, "eng-review").map((f) => f.id)).toEqual(["eng", "eng-review"]);
    expect(folderBreadcrumbTrail(model, "mine").map((f) => f.id)).toEqual(["my", "mine"]);
  });
});

describe("reserved subtree detection", () => {
  it("flags bundled root and descendants", () => {
    expect(isBundledFolder({ path: "bundled", systemKey: "bundled" })).toBe(true);
    expect(isBundledFolder({ path: "bundled/git", systemKey: "bundled:git" })).toBe(true);
    expect(isBundledFolder({ path: "engineering", systemKey: null })).toBe(false);
  });

  it("flags projects root and descendants", () => {
    expect(isProjectsFolder({ path: "projects", systemKey: "projects" })).toBe(true);
    expect(isProjectsFolder({ path: "projects/acme", systemKey: "project:a" })).toBe(true);
    expect(isProjectsFolder({ path: "my/dotta", systemKey: "my:u1" })).toBe(false);
  });
});

describe("reservedRootLabel", () => {
  it("renames reserved roots and passes through others", () => {
    expect(reservedRootLabel({ systemKey: "my", name: "my" })).toBe("My Skills");
    expect(reservedRootLabel({ systemKey: "projects", name: "projects" })).toBe("Projects");
    expect(reservedRootLabel({ systemKey: "bundled", name: "bundled" })).toBe("Bundled");
    expect(reservedRootLabel({ systemKey: null, name: "Engineering" })).toBe("Engineering");
  });
});

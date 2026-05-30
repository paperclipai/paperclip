import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogSkill } from "@paperclipai/shared";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.doMock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    statSync: mockStatSync,
    promises: {
      ...actual.promises,
      readFile: mockReadFile,
    },
  };
});

function catalogSkill(slug: string, name = slug): CatalogSkill {
  return {
    id: `paperclipai:bundled:software-development:${slug}`,
    key: `paperclipai/bundled/software-development/${slug}`,
    kind: "bundled",
    category: "software-development",
    slug,
    name,
    description: `${name} catalog skill used by the reload test.`,
    path: `catalog/bundled/software-development/${slug}`,
    entrypoint: "SKILL.md",
    trustLevel: "markdown_only",
    compatibility: "compatible",
    defaultInstall: false,
    recommendedForRoles: ["engineer"],
    requires: [],
    tags: ["test"],
    files: [{ path: "SKILL.md", kind: "skill", sizeBytes: 8, sha256: `sha256:${slug}` }],
    contentHash: `sha256:${slug}`,
  };
}

function manifest(skills: CatalogSkill[], packageVersion = "0.3.1") {
  return JSON.stringify({
    schemaVersion: 1,
    packageName: "@paperclipai/skills-catalog",
    packageVersion,
    generatedAt: "2026-05-28T00:00:00.000Z",
    skills,
  });
}

describe("skills catalog service", () => {
  let manifestJson: string;
  let manifestMtimeMs: number;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    manifestJson = manifest([catalogSkill("old-skill", "Old Skill")]);
    manifestMtimeMs = 1;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => manifestJson);
    mockStatSync.mockImplementation(() => ({
      mtimeMs: manifestMtimeMs,
      size: Buffer.byteLength(manifestJson),
    }));
    mockReadFile.mockImplementation(async (filePath: string) => `content:${filePath}`);
  });

  it("caches and reloads the generated catalog manifest when it changes", async () => {
    const service = await import("../services/skills-catalog.js");

    expect(service.listCatalogSkills().map((skill) => skill.key)).toEqual([
      "paperclipai/bundled/software-development/old-skill",
    ]);
    expect(service.listCatalogSkills().map((skill) => skill.key)).toEqual([
      "paperclipai/bundled/software-development/old-skill",
    ]);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);

    manifestJson = manifest([catalogSkill("new-skill", "New Skill")], "0.3.2");
    manifestMtimeMs += 1;

    expect(service.listCatalogSkills().map((skill) => skill.key)).toEqual([
      "paperclipai/bundled/software-development/new-skill",
    ]);
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
    expect(() => service.getCatalogSkillOrThrow("old-skill")).toThrow("Catalog skill not found");
    expect(service.getCatalogPackageMetadata()).toEqual({
      packageName: "@paperclipai/skills-catalog",
      packageVersion: "0.3.2",
    });
  });

  it("rejects catalog asset previews without decoding bytes as utf8", async () => {
    const imageSkill = catalogSkill("with-image", "With Image");
    imageSkill.files = [
      ...imageSkill.files,
      { path: "assets/logo.png", kind: "asset", sizeBytes: 4, sha256: "sha256:logo" },
    ];
    manifestJson = manifest([imageSkill]);
    const service = await import("../services/skills-catalog.js");

    await expect(service.readCatalogSkillFile(imageSkill.id, "assets/logo.png")).rejects.toMatchObject({
      status: 415,
      message: "Catalog asset previews are not supported.",
    });
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

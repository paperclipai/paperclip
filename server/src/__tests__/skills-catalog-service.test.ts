import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogSkill } from "@paperclipai/shared";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());
const mockRequireResolve = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

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

vi.doMock("node:module", async () => {
  const actual = await vi.importActual<typeof import("node:module")>("node:module");
  return {
    ...actual,
    createRequire: () => ({
      resolve: mockRequireResolve,
    }),
  };
});

vi.doMock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

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

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
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
    vi.unstubAllGlobals();
    manifestJson = manifest([catalogSkill("old-skill", "Old Skill")]);
    manifestMtimeMs = 1;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => manifestJson);
    mockStatSync.mockImplementation(() => ({
      mtimeMs: manifestMtimeMs,
      size: Buffer.byteLength(manifestJson),
    }));
    mockReadFile.mockImplementation(async (filePath: string) => `content:${filePath}`);
    mockRequireResolve.mockImplementation((specifier: string) => {
      if (specifier === "@paperclipai/skills-catalog/package.json") {
        return "/published/node_modules/@paperclipai/skills-catalog/package.json";
      }
      if (specifier === "@paperclipai/skills-catalog/catalog.json") {
        return "/published/node_modules/@paperclipai/skills-catalog/generated/catalog.json";
      }
      throw new Error(`Unexpected specifier: ${specifier}`);
    });
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

  it("reads referenced GitHub catalog files from pinned raw bytes", async () => {
    const markdown = "---\nname: remote\n---\n\n# Remote\n";
    const remoteSkill = catalogSkill("remote-skill", "Remote Skill");
    remoteSkill.source = {
      type: "github",
      hostname: "github.com",
      owner: "example",
      repo: "remote-skill",
      ref: "v1.0.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      path: "skills/remote",
      url: "https://github.com/example/remote-skill/tree/v1.0.0/skills/remote",
    };
    remoteSkill.files = [
      { path: "SKILL.md", kind: "skill", sizeBytes: Buffer.byteLength(markdown), sha256: sha256(markdown) },
    ];
    manifestJson = manifest([remoteSkill]);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://raw.githubusercontent.com/example/remote-skill/0123456789abcdef0123456789abcdef01234567/skills/remote/SKILL.md");
      return new Response(markdown, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = await import("../services/skills-catalog.js");

    await expect(service.readCatalogSkillFile(remoteSkill.id, "SKILL.md")).resolves.toMatchObject({
      catalogSkillId: remoteSkill.id,
      path: "SKILL.md",
      content: markdown,
      markdown: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("resolves the manifest and bundled skill files from the published package layout", async () => {
    const publishedMarkdown = "---\nname: published\n---\n\n# Published\n";
    const publishedSkill = catalogSkill("published-skill", "Published Skill");
    publishedSkill.files = [
      {
        path: "SKILL.md",
        kind: "skill",
        sizeBytes: Buffer.byteLength(publishedMarkdown),
        sha256: sha256(publishedMarkdown),
      },
    ];
    manifestJson = manifest([publishedSkill], "0.3.2");
    mockReadFile.mockImplementationOnce(async () => Buffer.from(publishedMarkdown));
    const service = await import("../services/skills-catalog.js");

    expect(service.getCatalogPackageMetadata()).toEqual({
      packageName: "@paperclipai/skills-catalog",
      packageVersion: "0.3.2",
    });
    await expect(service.readCatalogSkillFile(publishedSkill.id, "SKILL.md")).resolves.toMatchObject({
      catalogSkillId: publishedSkill.id,
      path: "SKILL.md",
      content: publishedMarkdown,
      markdown: true,
    });
    expect(mockReadFileSync).toHaveBeenCalledWith(
      "/published/node_modules/@paperclipai/skills-catalog/generated/catalog.json",
      "utf8",
    );
    expect(mockReadFile).toHaveBeenCalledWith(
      "/published/node_modules/@paperclipai/skills-catalog/catalog/bundled/software-development/published-skill/SKILL.md",
    );
    expect(mockRequireResolve).toHaveBeenCalledWith("@paperclipai/skills-catalog/package.json");
    expect(mockRequireResolve).toHaveBeenCalledWith("@paperclipai/skills-catalog/catalog.json");
  });

  it("returns an empty list and logs a warning when the manifest cannot be resolved", async () => {
    mockRequireResolve.mockImplementation(() => {
      const error = new Error("not found") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    mockExistsSync.mockReturnValue(false);
    const service = await import("../services/skills-catalog.js");

    expect(service.listCatalogSkillsOrEmpty()).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { err: expect.any(service.CatalogManifestUnavailableError) },
      "skills catalog manifest unavailable; returning empty catalog",
    );
  });
});

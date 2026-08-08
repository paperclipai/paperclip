import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentInstructionsService } from "../services/agent-instructions.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAgent(adapterConfig: Record<string, unknown>): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    adapterConfig,
  };
}

describe("agent instructions service", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("copies the existing bundle into the managed root when switching to managed mode", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const externalRoot = await makeTempDir("paperclip-agent-instructions-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, { mode: "managed" });

    expect(result.bundle.mode).toBe("managed");
    expect(result.bundle.managedRootPath).toBe(
      path.join(
        paperclipHome,
        "instances",
        "test-instance",
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "instructions",
      ),
    );
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "docs/TOOLS.md"]);
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe("# External Agent\n");
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("creates the target entry file when switching to a new external root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    const externalRoot = await makeTempDir("paperclip-agent-instructions-new-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, {
      mode: "external",
      rootPath: externalRoot,
      entryFile: "docs/AGENTS.md",
    });

    expect(result.bundle.mode).toBe("external");
    expect(result.bundle.rootPath).toBe(externalRoot);
    await expect(fs.readFile(path.join(externalRoot, "docs", "AGENTS.md"), "utf8")).resolves.toBe("# Managed Agent\n");
  });

  it("filters junk files, dependency bundles, and python caches from bundle listings and exports", async () => {
    const externalRoot = await makeTempDir("paperclip-agent-instructions-ignore-");
    cleanupDirs.add(externalRoot);

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".DS_Store"), "junk", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "module.pyc"), "compiled", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "._TOOLS.md"), "appledouble", "utf8");
    await fs.mkdir(path.join(externalRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "node_modules", "pkg", "index.js"), "export {};\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "python", "__pycache__"), { recursive: true });
    await fs.writeFile(
      path.join(externalRoot, "python", "__pycache__", "module.cpython-313.pyc"),
      "compiled",
      "utf8",
    );
    await fs.mkdir(path.join(externalRoot, ".pytest_cache"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, ".pytest_cache", "README.md"), "cache", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.files.map((file) => file.path)).toEqual([".gitignore", "AGENTS.md", "docs/TOOLS.md"]);
    expect(Object.keys(exported.files).sort((left, right) => left.localeCompare(right))).toEqual([
      ".gitignore",
      "AGENTS.md",
      "docs/TOOLS.md",
    ]);
  });

  it("recovers a managed bundle from disk when bundle config metadata is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-recover-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Recovered Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Recovered Agent\n" });
  });

  it("prefers the managed bundle on disk when managed metadata points at a stale root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-stale-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-stale-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });

  it("heals stale managed metadata when writing bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-write-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-write-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.writeFile(agent, "docs/TOOLS.md", "## Tools\n");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.readFile(path.join(managedRoot, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
  });

  it("heals stale managed metadata when deleting bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-delete-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-delete-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.deleteFile(agent, "docs/TOOLS.md");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.stat(path.join(managedRoot, "docs", "TOOLS.md"))).rejects.toThrow();
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("recovers the managed bundle when stale root metadata is present but mode is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-partial-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-partial-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });
});

// ---------------------------------------------------------------------------
// JAC-4748 Phase 2 / JAC-4896 — InstructionsFilePath set to merged path +
// feature-gating + adapterConfig instructionsFolderId/overrides support
// ---------------------------------------------------------------------------
import type { Db } from "@paperclipai/db";

function makeMockDbForInheritance(rows: unknown[]): Db {
  const mockExecute = vi.fn(async () => rows);
  return { execute: mockExecute } as unknown as Db;
}

function makeInheritanceAgent(
  adapterConfig: Record<string, unknown>,
  folderId = "folder-leaf",
): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "TestAgent",
    adapterType: "hermes_local",
    folderId: folderId ?? null,
    adapterConfig,
  };
}

async function writeFolderInstructions(
  instanceRoot: string,
  companyId: string,
  folderId: string,
  folderName: string,
  agendsContent: string,
  supplementary?: { fileName: string; content: string },
) {
  const dir = path.join(
    instanceRoot,
    "companies",
    companyId,
    "folders",
    folderId,
    "instructions",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "AGENTS.md"), agendsContent, "utf8");
  if (supplementary) {
    await fs.writeFile(
      path.join(dir, supplementary.fileName),
      supplementary.content,
      "utf8",
    );
  }
}

describe("JAC-4896: instructionsFilePath set to merged path", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
    await Promise.all(
      [...cleanupDirs].map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
        cleanupDirs.delete(dir);
      }),
    );
  });

  it("sets instructionsFilePath to the generated merged file path when agent has folderId", async () => {
    const paperclipHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-jac4896-merged-"),
    );
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const foldersDir = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "folders",
    );
    // Root folder
    await writeFolderInstructions(
      path.join(paperclipHome, "instances", "test-instance"),
      "company-1",
      "folder-root",
      "Root",
      "# Root Instructions\nShared root guidance.",
    );
    // Leaf folder (child of root)
    await writeFolderInstructions(
      path.join(paperclipHome, "instances", "test-instance"),
      "company-1",
      "folder-leaf",
      "Leaf",
      "# Leaf Instructions\nLeaf-specific guidance.",
    );

    // Mock DB returns the folder chain (root -> leaf)
    const db = makeMockDbForInheritance([
      { id: "folder-root", parentId: null, name: "Root", slug: "root" },
      { id: "folder-leaf", parentId: "folder-root", name: "Leaf", slug: "leaf" },
    ]);

    const svc = agentInstructionsService(db);
    const agent = makeInheritanceAgent({}, "folder-leaf");

    const bundle = await svc.getBundle(agent);

    // Inheritance should be resolved
    expect(bundle.inheritanceChain).toHaveLength(2);
    expect(bundle.instructionsFingerprint).toBeTruthy();
    // Step 4: instructionsFilePath should be set to the merged file path
    expect(bundle.instructionsFilePath).toBeTruthy();
    expect(bundle.instructionsFilePath).toContain("__generated__");
    expect(bundle.instructionsFilePath).toContain("merged.md");
    expect(bundle.generatedInstructionsPath).toBe(bundle.instructionsFilePath);
    // The merged content should contain both folder instructions
    expect(bundle.instructionsOverrides).toBeNull();
    expect(bundle.instructionsFolderId).toBe("folder-leaf");
  });

  it("honors adapterConfig.instructionsFolderId over DB folderId", async () => {
    const paperclipHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-jac4896-config-folder-"),
    );
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await writeFolderInstructions(
      path.join(paperclipHome, "instances", "test-instance"),
      "company-1",
      "folder-config",
      "ConfigFolder",
      "# Config Folder Instructions",
    );

    const db = makeMockDbForInheritance([
      { id: "folder-config", parentId: null, name: "ConfigFolder", slug: "config" },
    ]);

    const svc = agentInstructionsService(db);
    // agent.folderId is null, but adapterConfig.instructionsFolderId is set
    const agent = makeInheritanceAgent(
      { instructionsFolderId: "folder-config" },
      null as any,
    );

    const bundle = await svc.getBundle(agent);

    expect(bundle.instructionsFolderId).toBe("folder-config");
    expect(bundle.instructionsFilePath).toBeTruthy();
    expect(bundle.instructionsFilePath).toContain("merged.md");
  });

  it("includes adapterConfig.instructionsOverrides in merged instructions", async () => {
    const paperclipHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-jac4896-overrides-"),
    );
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await writeFolderInstructions(
      path.join(paperclipHome, "instances", "test-instance"),
      "company-1",
      "folder-root",
      "Root",
      "# Root Instructions",
    );

    const db = makeMockDbForInheritance([
      { id: "folder-root", parentId: null, name: "Root", slug: "root" },
    ]);

    const svc = agentInstructionsService(db);
    const agent = makeInheritanceAgent(
      { instructionsOverrides: "Act as a pirate in all responses." },
      "folder-root",
    );

    const bundle = await svc.getBundle(agent);

    expect(bundle.instructionsOverrides).toBe("Act as a pirate in all responses.");
    expect(bundle.instructionsFilePath).toBeTruthy();
    // Read the merged file and verify the override content is present
    const mergedContent = await fs.readFile(
      bundle.instructionsFilePath!,
      "utf8",
    );
    expect(mergedContent).toContain("Act as a pirate in all responses.");
    expect(mergedContent).toContain("[Agent: TestAgent (override)]");
  });

  it("supplements folder instructions with adapter manifest HERMES.md", async () => {
    const paperclipHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-jac4896-supplement-"),
    );
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await writeFolderInstructions(
      path.join(paperclipHome, "instances", "test-instance"),
      "company-1",
      "folder-root",
      "Root",
      "# Root Instructions",
      { fileName: "HERMES.md", content: "# Hermes-Specific Guidance\nUse tools wisely." },
    );

    const db = makeMockDbForInheritance([
      { id: "folder-root", parentId: null, name: "Root", slug: "root" },
    ]);

    const svc = agentInstructionsService(db);
    const agent = makeInheritanceAgent({}, "folder-root");

    const bundle = await svc.getBundle(agent);

    expect(bundle.instructionsSupplementaryFiles).toEqual({ hermes: "HERMES.md" });
    expect(bundle.instructionsFilePath).toBeTruthy();
    const mergedContent = await fs.readFile(
      bundle.instructionsFilePath!,
      "utf8",
    );
    expect(mergedContent).toContain("Hermes-Specific Guidance");
  });

  it("skips folder inheritance for adapters that do not support instructions bundles", async () => {
    const paperclipHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-jac4896-noinherit-"),
    );
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await writeFolderInstructions(
      path.join(paperclipHome, "instances", "test-instance"),
      "company-1",
      "folder-root",
      "Root",
      "# Root Instructions",
    );

    const db = makeMockDbForInheritance([
      { id: "folder-root", parentId: null, name: "Root", slug: "root" },
    ]);

    const svc = agentInstructionsService(db);
    // openclaw_gateway does not support instructionsBundle
    const agent: TestAgent = {
      id: "agent-1",
      companyId: "company-1",
      name: "TestAgent",
      adapterType: "openclaw_gateway",
      folderId: "folder-root",
      adapterConfig: {},
    };

    const bundle = await svc.getBundle(agent);

    // No inheritance should be resolved
    expect(bundle.inheritanceChain).toBeUndefined();
    expect(bundle.instructionsFilePath).toBeUndefined();
  });

  it("fails open gracefully when DB query throws during inheritance resolution", async () => {
    const paperclipHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-jac4896-failopen-"),
    );
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    // DB that throws when queried (simulates DB unreachable)
    const db = {
      execute: vi.fn(async () => {
        throw new Error("DB connection refused");
      }),
    } as unknown as Db;

    const svc = agentInstructionsService(db);
    const agent = makeInheritanceAgent({}, "folder-root");

    const bundle = await svc.getBundle(agent);

    // Should still return a bundle, with a warning about the failure
    expect(bundle).toBeDefined();
    expect(bundle.warnings.length).toBeGreaterThan(0);
    expect(bundle.instructionsFilePath).toBeUndefined();
    expect(bundle.instructionsFilePath).toBeUndefined();
  });
});

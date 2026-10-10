import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as persistentFiles from "../services/persistent-agent-files.js";
import { agentInstructionsService } from "../services/agent-instructions.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
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

  beforeEach(async () => {
    const home = await makeTempDir("agent-instructions-test-home-");
    cleanupDirs.add(home);
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "instructions-service-test";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it.each(["./AGENTS.md", "notes/../AGENTS.md", "notes\\..\\AGENTS.md", "../invalid"])("reads legacy entry configuration %s without breaking the bundle", async (entry) => {
    const root = await makeTempDir("legacy-entry-"); cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "legacy instructions");
    const agent = makeAgent({ instructionsBundleMode: "external", instructionsRootPath: root, instructionsEntryFile: entry });
    const svc = agentInstructionsService();
    const bundle = await svc.getBundle(agent);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect((await svc.readFile(agent, bundle.entryFile)).content).toBe("legacy instructions");
    if (entry === "../invalid") expect(bundle.warnings.length).toBeGreaterThan(0);
  });

  it.each(["explicit", "legacy"])("keeps %s external instructions on their configured root after selecting Boat", async (configuration) => {
    const root = await makeTempDir("boat-external-instructions-"); cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "external authority");
    await fs.writeFile(path.join(root, "NEXT.md"), "next external entry");
    const agent = { ...makeAgent(configuration === "explicit"
      ? { instructionsBundleMode: "external", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" }
      : { instructionsFilePath: path.join(root, "AGENTS.md") }), defaultEnvironmentId: "boat-environment" };
    const remote = vi.spyOn(persistentFiles, "persistentAgentFiles").mockResolvedValue({ root: "/remote/personal" } as never);
    const db = { transaction: vi.fn(async () => { throw new Error("Must not adopt external instructions"); }) };
    const svc = agentInstructionsService(db as never);
    expect((await svc.getBundle(agent)).rootPath).toBe(root);
    expect((await svc.readFile(agent, "AGENTS.md")).content).toBe("external authority");
    expect((await svc.exportFiles(agent)).files["AGENTS.md"]).toBe("external authority");
    const updated = await svc.updateBundle(agent, { entryFile: "NEXT.md" });
    expect(updated.bundle.mode).toBe("external");
    expect(updated.bundle.rootPath).toBe(root);
    expect(updated.bundle.entryFile).toBe("NEXT.md");
    expect(remote).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("previews an explicit external-to-managed migration before adopting remote personal files", async () => {
    const root = await makeTempDir("boat-instructions-migration-"); cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "external migration source");
    const agent = makeAgent({ instructionsBundleMode: "external", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" });
    const seedBytes = vi.fn();
    vi.spyOn(persistentFiles, "persistentAgentFiles").mockResolvedValue({ root: "/remote/personal", seedBytes } as never);
    const db = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        select: () => ({ from: () => ({ where: async () => [agent] }) }),
      }),
    };
    const svc = agentInstructionsService(db as never);
    const updated = await svc.updateBundle(agent, { mode: "managed" });
    expect(updated.bundle.mode).toBe("managed");
    expect(updated.bundle.rootPath).toBe(updated.bundle.managedRootPath);
    expect(await fs.readFile(path.join(updated.bundle.managedRootPath, "AGENTS.md"), "utf8")).toBe("external migration source");
    expect(seedBytes).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("external migration source");
  });

  it("lists external bundles containing large binary assets", async () => {
    const root = await makeTempDir("external-large-assets-"); cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "external instructions");
    const asset = await fs.open(path.join(root, "large.bin"), "w");
    try { await asset.truncate(17 * 1024 * 1024); } finally { await asset.close(); }
    const agent = makeAgent({ instructionsBundleMode: "external", instructionsRootPath: root });
    const svc = agentInstructionsService();
    const bundle = await svc.getBundle(agent);
    expect(bundle.files).toContainEqual(expect.objectContaining({ path: "large.bin", binary: true, editable: false }));
    expect((await svc.readFile(agent, "AGENTS.md")).content).toBe("external instructions");
  });

  it("rejects reserved paths while initializing an unconfigured managed bundle", async () => {
    const root = await makeTempDir("unconfigured-reserved-path-"); cleanupDirs.add(root);
    process.env.PAPERCLIP_HOME = root;
    const svc = agentInstructionsService();
    await expect(svc.writeFile(makeAgent({}), ".paperclip-runtime/state", "invalid")).rejects.toMatchObject({ status: 422 });
    expect(await fs.readdir(root)).toEqual([]);
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

    const svc = agentInstructionsService({ select: () => ({ from: () => ({ where: async () => [] }) }) } as never);
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

  it.skipIf(process.platform === "win32")("rejects instruction symlinks for immutable runner snapshots without changing legacy exports", async () => {
    const externalRoot = await makeTempDir("paperclip-agent-instructions-symlink-");
    const outsideRoot = await makeTempDir("paperclip-agent-instructions-outside-");
    cleanupDirs.add(externalRoot);
    cleanupDirs.add(outsideRoot);
    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "Read sibling.md\n", "utf8");
    await fs.writeFile(path.join(outsideRoot, "secret.md"), "must not enter the bundle\n", "utf8");
    await fs.symlink(path.join(outsideRoot, "secret.md"), path.join(externalRoot, "sibling.md"));
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });
    const svc = agentInstructionsService();

    await expect(svc.exportFiles(agent)).resolves.toMatchObject({
      files: { "AGENTS.md": "Read sibling.md\n" },
    });
    await expect(svc.exportFiles(agent, { rejectSymlinks: true }))
      .rejects.toThrow("Instructions bundle may not contain symlinks: sibling.md");
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
    expect(bundle.entryFile).toBe("docs/MISSING.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
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
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(managedRoot, "docs/MISSING.md"),
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
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(managedRoot, "docs/MISSING.md"),
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
    expect(bundle.entryFile).toBe("docs/MISSING.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });
});

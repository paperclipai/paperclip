import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
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

  it("preserves the whole operator-modified tree during routine materialization", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-drift-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const initial = await svc.materializeManagedBundle(agent, {
      "AGENTS.md": "# Stock v1\n",
      "docs/STOCK.md": "Stock docs\n",
    });
    expect(initial.materialization).toMatchObject({ stockStatus: "missing", action: "added" });
    const managedRoot = initial.bundle.managedRootPath;
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Operator edit\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "OPERATOR.md"), "Operator-added file\n", "utf8");

    const rebuilt = await svc.materializeManagedBundle(
      { ...agent, adapterConfig: initial.adapterConfig },
      {
        "AGENTS.md": "# Stock v2\n",
        "docs/STOCK.md": "Updated stock docs\n",
      },
    );

    expect(rebuilt.materialization).toMatchObject({
      stockStatus: "operator_modified",
      action: "skipped",
      skipped: ["AGENTS.md", "OPERATOR.md", "docs/STOCK.md"],
      backupPath: null,
    });
    expect(rebuilt.adapterConfig.instructionsStockHash).toBe(initial.adapterConfig.instructionsStockHash);
    await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).resolves.toBe("# Operator edit\n");
    await expect(fs.readFile(path.join(managedRoot, "OPERATOR.md"), "utf8")).resolves.toBe("Operator-added file\n");
    await expect(fs.readFile(path.join(managedRoot, "docs", "STOCK.md"), "utf8")).resolves.toBe("Stock docs\n");
  });

  it("atomically advances a clean stock tree and its recorded hash", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-update-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
    const initial = await svc.materializeManagedBundle(agent, {
      "AGENTS.md": "# Stock v1\n",
      "docs/OLD.md": "Old\n",
    });

    const updated = await svc.materializeManagedBundle(
      { ...agent, adapterConfig: initial.adapterConfig },
      {
        "AGENTS.md": "# Stock v2\n",
        "docs/NEW.md": "New\n",
      },
    );

    expect(updated.materialization).toMatchObject({
      stockStatus: "stock_update_available",
      action: "updated",
      added: ["docs/NEW.md"],
      removed: ["docs/OLD.md"],
      updated: ["AGENTS.md"],
      backupPath: null,
    });
    expect(updated.adapterConfig.instructionsStockHash).toBe(updated.materialization.stockHash);
    expect(updated.adapterConfig.instructionsStockHash).not.toBe(initial.adapterConfig.instructionsStockHash);
    await expect(fs.readFile(path.join(updated.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe("# Stock v2\n");
    await expect(fs.readFile(path.join(updated.bundle.managedRootPath, "docs", "NEW.md"), "utf8")).resolves.toBe("New\n");
    await expect(fs.stat(path.join(updated.bundle.managedRootPath, "docs", "OLD.md"))).rejects.toThrow();
  });

  it("serializes concurrent routine materializations for the same agent", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-concurrent-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
    const initial = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock v1\n" });
    const configuredAgent = { ...agent, adapterConfig: initial.adapterConfig };

    const [first, second] = await Promise.all([
      svc.materializeManagedBundle(configuredAgent, { "AGENTS.md": "# Stock v2\n" }),
      agentInstructionsService().materializeManagedBundle(configuredAgent, {
        "AGENTS.md": "# Stock v3\n",
      }),
    ]);

    expect(first.materialization.action).toBe("updated");
    expect(second.materialization).toMatchObject({
      stockStatus: "operator_modified",
      action: "skipped",
    });
    await expect(fs.readFile(path.join(initial.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Stock v2\n",
    );
  });

  it("recovers a managed materialization lock left by a dead process", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-stale-lock-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
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
    const lockPath = `${managedRoot}.paperclip-materialize.lock`;
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 2_147_483_647, token: "stale", createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    const result = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });

    expect(result.materialization.action).toBe("added");
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("lets only one contender reap a stale managed materialization lock", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-stale-lock-race-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const agent = makeAgent({});
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
    const lockPath = `${managedRoot}.paperclip-materialize.lock`;
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000000",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => agentInstructionsService().materializeManagedBundle(
        agent,
        { "AGENTS.md": `# Stock ${index}\n` },
      )),
    );

    expect(results.filter((result) => result.materialization.action === "added")).toHaveLength(1);
    expect(results.filter((result) => result.materialization.action === "skipped")).toHaveLength(7);
    await expect(fs.stat(lockPath)).rejects.toThrow();
    const live = await fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8");
    expect(Array.from({ length: 8 }, (_, index) => `# Stock ${index}\n`)).toContain(live);
  });

  it("publishes owner metadata atomically with the materialization lock", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-lock-publish-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const agent = makeAgent({});
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
    const lockPath = `${managedRoot}.paperclip-materialize.lock`;
    const originalRename = fs.rename.bind(fs);
    let pendingLockPath: string | null = null;
    let publish: (() => void) | null = null;
    const publishAllowed = new Promise<void>((resolve) => {
      publish = resolve;
    });
    let pendingReady: (() => void) | null = null;
    const pendingPrepared = new Promise<void>((resolve) => {
      pendingReady = resolve;
    });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (String(source).startsWith(`${lockPath}.pending-`) && String(destination) === lockPath) {
        pendingLockPath = String(source);
        pendingReady?.();
        await publishAllowed;
      }
      return originalRename(source, destination);
    });
    const materialization = agentInstructionsService().materializeManagedBundle(
      agent,
      { "AGENTS.md": "# Stock\n" },
    );

    try {
      await pendingPrepared;
      await expect(fs.stat(lockPath)).rejects.toThrow();
      expect(pendingLockPath).not.toBeNull();
      await expect(fs.readFile(path.join(pendingLockPath!, "owner.json"), "utf8")).resolves.toContain(
        `"pid":${process.pid}`,
      );
      const pendingFiles = await fs.readdir(pendingLockPath!);
      expect(pendingFiles.some((file) => file.startsWith("heartbeat-"))).toBe(true);
    } finally {
      publish?.();
    }

    await expect(materialization).resolves.toMatchObject({ materialization: { action: "added" } });
    renameSpy.mockRestore();
  });

  it("does not evict an old materialization lock owned by a live process", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-live-lock-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
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
    const lockPath = `${managedRoot}.paperclip-materialize.lock`;
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: "live", createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    const materialization = svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });
    const firstOutcome = await Promise.race([
      materialization.then(() => "materialized"),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 75)),
    ]);

    expect(firstOutcome).toBe("waiting");
    const releasedLockPath = `${lockPath}.released`;
    await fs.rename(lockPath, releasedLockPath);
    await fs.rm(releasedLockPath, { recursive: true, force: true });
    await expect(materialization).resolves.toMatchObject({
      materialization: { action: "added" },
    });
  });

  it("recovers a stale lock whose PID was reused by another process", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-reused-pid-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
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
    const lockPath = `${managedRoot}.paperclip-materialize.lock`;
    const token = "00000000-0000-4000-8000-000000000000";
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token,
        processStartMarker: process.platform === "linux"
          ? "linux:not-the-current-process-start"
          : "ps:not-the-current-process-start",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(lockPath, `heartbeat-${token}`), "", "utf8");

    const result = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });

    expect(result.materialization.action).toBe("added");
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("recovers a probe-less legacy lock after its PID is reused", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-legacy-stale-lock-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
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
    const lockPath = `${managedRoot}.paperclip-materialize.lock`;
    const token = randomUUID();
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token, createdAt: "1970-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    const heartbeatPath = path.join(lockPath, `heartbeat-${token}`);
    await fs.writeFile(heartbeatPath, "", "utf8");
    const staleHeartbeat = new Date(Date.now() - 60_000);
    await fs.utimes(heartbeatPath, staleHeartbeat, staleHeartbeat);

    const result = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });

    expect(result.materialization.action).toBe("added");
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("preserves a probe-less legacy lock when its live owner heartbeat is stale", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-legacy-live-lock-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
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
    const lockPath = `${managedRoot}.paperclip-materialize.lock`;
    const token = randomUUID();
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    const heartbeatPath = path.join(lockPath, `heartbeat-${token}`);
    await fs.writeFile(heartbeatPath, "", "utf8");
    const staleHeartbeat = new Date(Date.now() - 60_000);
    await fs.utimes(heartbeatPath, staleHeartbeat, staleHeartbeat);

    const materialization = svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });
    const firstOutcome = await Promise.race([
      materialization.then(() => "materialized"),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 75)),
    ]);

    expect(firstOutcome).toBe("waiting");
    const releasedLockPath = `${lockPath}.released`;
    await fs.rename(lockPath, releasedLockPath);
    await fs.rm(releasedLockPath, { recursive: true, force: true });
    await expect(materialization).resolves.toMatchObject({
      materialization: { action: "added" },
    });
  });

  it.skipIf(process.platform !== "linux")(
    "does not evict a live lock with a stale heartbeat when its identity scheme is unavailable",
    async () => {
      const paperclipHome = await makeTempDir("paperclip-agent-instructions-marker-fallback-");
      cleanupDirs.add(paperclipHome);
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
      const svc = agentInstructionsService();
      const agent = makeAgent({});
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
      const lockPath = `${managedRoot}.paperclip-materialize.lock`;
      const token = randomUUID();
      const probePath = `\0paperclip-managed-bundle-${token}`;
      const probe = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(probePath, resolve);
      });
      probe.unref();
      await fs.mkdir(lockPath, { recursive: true });
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token,
          probePath,
          processStartMarker: "unavailable:same-live-process-in-another-format",
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      const heartbeatPath = path.join(lockPath, `heartbeat-${token}`);
      await fs.writeFile(heartbeatPath, "", "utf8");
      const staleHeartbeat = new Date(Date.now() - 60_000);
      await fs.utimes(heartbeatPath, staleHeartbeat, staleHeartbeat);

      const materialization = svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });
      const firstOutcome = await Promise.race([
        materialization.then(() => "materialized"),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 75)),
      ]);

      expect(firstOutcome).toBe("waiting");
      const releasedLockPath = `${lockPath}.released`;
      await fs.rename(lockPath, releasedLockPath);
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      await fs.rm(releasedLockPath, { recursive: true, force: true });
      await expect(materialization).resolves.toMatchObject({
        materialization: { action: "added" },
      });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not evict a live lock after a transient probe connection error",
    async () => {
      const paperclipHome = await makeTempDir("paperclip-agent-instructions-probe-retry-");
      cleanupDirs.add(paperclipHome);
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
      const svc = agentInstructionsService();
      const agent = makeAgent({});
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
      const lockPath = `${managedRoot}.paperclip-materialize.lock`;
      const token = randomUUID();
      const probePath = `\0paperclip-managed-bundle-${token}`;
      const probe = net.createServer((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(probePath, resolve);
      });
      probe.unref();
      await fs.mkdir(lockPath, { recursive: true });
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token,
          probePath,
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      await fs.writeFile(path.join(lockPath, `heartbeat-${token}`), "", "utf8");

      const originalCreateConnection = net.createConnection.bind(net);
      let connectionAttempts = 0;
      const createConnectionSpy = vi
        .spyOn(net, "createConnection")
        .mockImplementation(((...args: Parameters<typeof net.createConnection>) => {
          connectionAttempts += 1;
          if (connectionAttempts === 1) {
            const socket = new net.Socket();
            queueMicrotask(() => {
              socket.emit("error", Object.assign(new Error("transient probe failure"), {
                code: "EAGAIN",
              }));
            });
            return socket;
          }
          return originalCreateConnection(...args);
        }) as typeof net.createConnection);
      const materialization = svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });

      try {
        const firstOutcome = await Promise.race([
          materialization.then(() => "materialized"),
          new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 100)),
        ]);
        expect(firstOutcome).toBe("waiting");
        expect(connectionAttempts).toBeGreaterThanOrEqual(2);
      } finally {
        createConnectionSpy.mockRestore();
        const releasedLockPath = `${lockPath}.released`;
        await fs.rename(lockPath, releasedLockPath);
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        await fs.rm(releasedLockPath, { recursive: true, force: true });
      }

      await expect(materialization).resolves.toMatchObject({
        materialization: { action: "added" },
      });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "recovers a reused PID after its liveness probe is released",
    async () => {
      const paperclipHome = await makeTempDir("paperclip-agent-instructions-ps-reused-pid-");
      cleanupDirs.add(paperclipHome);
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
      const svc = agentInstructionsService();
      const agent = makeAgent({});
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
      const lockPath = `${managedRoot}.paperclip-materialize.lock`;
      const token = randomUUID();
      const probePath = `\0paperclip-managed-bundle-${token}`;
      await fs.mkdir(lockPath, { recursive: true });
      await fs.writeFile(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          token,
          probePath,
          processStartMarker: "unavailable:not-the-current-process-start",
          createdAt: new Date().toISOString(),
        })}\n`,
        "utf8",
      );
      await fs.writeFile(path.join(lockPath, `heartbeat-${token}`), "", "utf8");

      const result = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\n" });

      expect(result.materialization.action).toBe("added");
      await expect(fs.stat(lockPath)).rejects.toThrow();
    },
  );

  it("canonicalizes line endings and ignores transient files when classifying drift", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-canonical-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
    const initial = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock\nLine\n" });
    const managedRoot = initial.bundle.managedRootPath;
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Stock\r\nLine\r\n", "utf8");
    await fs.writeFile(path.join(managedRoot, ".DS_Store"), "transient", "utf8");

    const unchanged = await svc.materializeManagedBundle(
      { ...agent, adapterConfig: initial.adapterConfig },
      { "AGENTS.md": "# Stock\nLine\n" },
    );

    expect(unchanged.materialization).toMatchObject({ stockStatus: "stock_current", action: "unchanged" });
    await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).resolves.toBe("# Stock\r\nLine\r\n");
    await expect(fs.readFile(path.join(managedRoot, ".DS_Store"), "utf8")).resolves.toBe("transient");
  });

  it("rolls the live tree back when the staged atomic swap fails", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-rollback-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
    const initial = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock v1\n" });
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (path.basename(String(source)) === "staged") throw new Error("simulated swap failure");
      return originalRename(source, destination);
    });

    try {
      await expect(svc.materializeManagedBundle(
        { ...agent, adapterConfig: initial.adapterConfig },
        { "AGENTS.md": "# Stock v2\n" },
      )).rejects.toThrow("simulated swap failure");
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.readFile(path.join(initial.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe("# Stock v1\n");
  });

  it("backs up operator state before an explicitly requested force reset", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-reset-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
    const initial = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock v1\n" });
    const managedRoot = initial.bundle.managedRootPath;
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Operator edit\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "OPERATOR.md"), "Keep me\n", "utf8");

    const reset = await svc.forceResetManagedBundle(
      { ...agent, adapterConfig: initial.adapterConfig },
      { "AGENTS.md": "# Stock v2\n" },
    );

    expect(reset.materialization).toMatchObject({
      stockStatus: "operator_modified",
      action: "reset",
      backupPath: `${managedRoot}.backup-1`,
      backedUp: ["AGENTS.md", "OPERATOR.md"],
    });
    await expect(fs.readFile(path.join(`${managedRoot}.backup-1`, "AGENTS.md"), "utf8")).resolves.toBe("# Operator edit\n");
    await expect(fs.readFile(path.join(`${managedRoot}.backup-1`, "OPERATOR.md"), "utf8")).resolves.toBe("Keep me\n");
    await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).resolves.toBe("# Stock v2\n");
    await expect(fs.stat(path.join(managedRoot, "OPERATOR.md"))).rejects.toThrow();

    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Second operator edit\n", "utf8");
    const secondReset = await svc.forceResetManagedBundle(
      { ...agent, adapterConfig: reset.adapterConfig },
      { "AGENTS.md": "# Stock v3\n" },
    );
    expect(secondReset.materialization.backupPath).toBe(`${managedRoot}.backup-2`);
    await expect(fs.readFile(path.join(`${managedRoot}.backup-1`, "AGENTS.md"), "utf8")).resolves.toBe("# Operator edit\n");
    await expect(fs.readFile(path.join(`${managedRoot}.backup-2`, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Second operator edit\n",
    );
  });

  it("allocates distinct backups for concurrent force resets", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-concurrent-reset-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    const svc = agentInstructionsService();
    const agent = makeAgent({});
    const initial = await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Stock v1\n" });
    const configuredAgent = { ...agent, adapterConfig: initial.adapterConfig };

    const [first, second] = await Promise.all([
      svc.forceResetManagedBundle(configuredAgent, { "AGENTS.md": "# Stock v2\n" }),
      agentInstructionsService().forceResetManagedBundle(configuredAgent, {
        "AGENTS.md": "# Stock v3\n",
      }),
    ]);

    expect(new Set([first.materialization.backupPath, second.materialization.backupPath])).toEqual(
      new Set([
        `${initial.bundle.managedRootPath}.backup-1`,
        `${initial.bundle.managedRootPath}.backup-2`,
      ]),
    );
    await expect(
      fs.readFile(path.join(`${initial.bundle.managedRootPath}.backup-1`, "AGENTS.md"), "utf8"),
    ).resolves.toBe("# Stock v1\n");
    const [secondBackup, live] = await Promise.all([
      fs.readFile(path.join(`${initial.bundle.managedRootPath}.backup-2`, "AGENTS.md"), "utf8"),
      fs.readFile(path.join(initial.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ]);
    expect(new Set([secondBackup, live])).toEqual(new Set(["# Stock v2\n", "# Stock v3\n"]));
  });
});

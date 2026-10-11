import fs from "node:fs/promises";
import { agents } from "@paperclipai/db";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fileStore from "../services/agent-file-store.js";
import * as persistentFiles from "../services/persistent-agent-files.js";
import { agentInstructionsService, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";

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

  function remoteInitializationFixture(existing: Record<string, string> | null, versioned = false) {
    const agent = makeAgent({});
    let homeExists = existing !== null;
    const contents = new Map(Object.entries(existing ?? {}));
    const absent = () => Object.assign(new Error("Missing remote file"), { code: "not_found" });
    const seed = vi.fn(async (files: Record<string, string>) => {
      if (homeExists) return { seeded: false };
      homeExists = true;
      for (const [name, content] of Object.entries(files)) contents.set(name, content);
      return { seeded: true };
    });
    const hash = vi.fn(async (name: string) => {
      const content = contents.get(name);
      if (content === undefined) throw absent();
      return { sha256: fileStore.fileHash(Buffer.from(content)), size: Buffer.byteLength(content) };
    });
    const write = vi.fn(async (name: string, content: string, expected: string | null) => {
      expect(expected).toBeNull();
      if (contents.has(name)) throw Object.assign(new Error("File conflict"), { status: 409 });
      contents.set(name, content);
      return { sha256: fileStore.fileHash(Buffer.from(content)) };
    });
    const remote = { root: "/remote/home", seed, hash, write,
      stat: async (name: string) => ({ kind: "file", ...(await hash(name)) }),
      readBytes: async (name: string) => ({ bytes: Buffer.from(contents.get(name)!), ...(await hash(name)) }),
      listPage: async () => ({ entries: [...contents].map(([name, content]) => ({ name, kind: "file", size: Buffer.byteLength(content) })), truncated: false }),
    };
    const access = vi.spyOn(persistentFiles, "persistentAgentFiles").mockResolvedValue(remote as never);
    const adopt = vi.spyOn(fileStore, "adoptAgentFiles").mockResolvedValue("/controller/home");
    const readSeed = vi.spyOn(persistentFiles, "seedPersistentAgentHome").mockImplementation(async () => {
      expect(homeExists).toBe(true);
      expect(contents.has("AGENTS.md")).toBe(true);
    });
    const tx = { select: () => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === agents ? [agent] : versioned ? [{ revisionId: "existing-revision" }] : [];
      return Object.assign(Promise.resolve(rows), { for: async () => rows, limit: async () => rows });
    } }) }) };
    const db = { ...tx, transaction: async (fn: (value: unknown) => Promise<unknown>) => fn(tx) };
    return { agent, contents, remote, access, adopt, readSeed, svc: agentInstructionsService(db as never) };
  }

  it.each([null, {}, { "AGENTS.md": "initial", "personal.txt": "keep" }])(
    "initializes persistent instructions without replacing an absent, empty, or identical home (%j)", async (existing) => {
      const f = remoteInitializationFixture(existing);
      const result = await f.svc.materializeManagedBundle(f.agent, { "AGENTS.md": "initial", "TOOLS.md": "tools" }, { replaceExisting: false });
      expect(result.bundle.rootPath).toBe("/remote/home");
      expect(result.bundle.files.map(file => file.path)).toContain("AGENTS.md");
      expect(f.contents.get("AGENTS.md")).toBe("initial");
      expect(f.contents.get("TOOLS.md")).toBe("tools");
      if (existing && "personal.txt" in existing) expect(f.contents.get("personal.txt")).toBe("keep");
      if (existing === null) expect(f.remote.write).not.toHaveBeenCalled();
      expect(f.readSeed).toHaveBeenCalledOnce();
      f.remote.write.mockClear();
      await f.svc.materializeManagedBundle(f.agent, { "AGENTS.md": "initial", "TOOLS.md": "tools" });
      expect(f.remote.write).not.toHaveBeenCalled();
    },
  );

  it("preserves controller personal files before a first remote template initialization", async () => {
    const f = remoteInitializationFixture(null);
    const root = resolveManagedInstructionsRoot(f.agent);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "personal.txt"), "local personal content");
    f.readSeed.mockImplementationOnce(async (remote, localRoot) => {
      expect(localRoot).toBe(root);
      await remote.seed({ "personal.txt": await fs.readFile(path.join(localRoot, "personal.txt"), "utf8") });
    });
    await f.svc.materializeManagedBundle(f.agent, { "AGENTS.md": "initial" });
    expect(Object.fromEntries(f.contents)).toEqual({ "personal.txt": "local personal content", "AGENTS.md": "initial" });
    expect(f.remote.seed.mock.calls[0][0]).toEqual({ "personal.txt": "local personal content" });
    expect(f.remote.write).toHaveBeenCalledExactlyOnceWith("AGENTS.md", "initial", null);
  });

  it("preflights the entire persistent bundle before adding files when existing content differs", async () => {
    const f = remoteInitializationFixture({ "AGENTS.md": "user edit", "personal.txt": "keep" });
    await expect(f.svc.materializeManagedBundle(f.agent, { "TOOLS.md": "new", "AGENTS.md": "stock" }))
      .rejects.toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT", path: "AGENTS.md" } });
    expect(f.remote.write).not.toHaveBeenCalled();
    expect(Object.fromEntries(f.contents)).toEqual({ "AGENTS.md": "user edit", "personal.txt": "keep" });
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it("keeps persistent replacement and revision-history guards before any seed or write", async () => {
    const f = remoteInitializationFixture(null);
    await expect(f.svc.materializeManagedBundle(f.agent, { "AGENTS.md": "stock" }, { replaceExisting: true }))
      .rejects.toMatchObject({ status: 422 });
    expect(f.remote.seed).not.toHaveBeenCalled();
    expect(f.remote.write).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const versioned = remoteInitializationFixture({}, true);
    await expect(versioned.svc.materializeManagedBundle(versioned.agent, { "AGENTS.md": "stock" }))
      .rejects.toMatchObject({ status: 422, details: { code: "INSTRUCTION_REVISION_REQUIRED" } });
    expect(versioned.access).not.toHaveBeenCalled();
  });

  it.each([
    { "AGENTS.md": "stock", ".paperclip-runtime/state": "reserved" },
    { "AGENTS.md": "stock", "./AGENTS.md": "alias" },
    { "AGENTS.md": "stock", "../outside": "escape" },
  ])("validates every initialization path before remote mutations (%j)", async files => {
    const f = remoteInitializationFixture(null);
    await expect(f.svc.materializeManagedBundle(f.agent, files)).rejects.toMatchObject({ status: 422 });
    expect(f.remote.seed).not.toHaveBeenCalled();
    expect(f.remote.write).not.toHaveBeenCalled();
  });

  it.each(["initial", "concurrent user edit"])("accepts only identical create-CAS winners (%s)", async winner => {
    const f = remoteInitializationFixture({});
    f.remote.write.mockImplementationOnce(async (name) => {
      f.contents.set(name, winner);
      throw Object.assign(new Error("File conflict"), { status: 409 });
    });
    const operation = f.svc.materializeManagedBundle(f.agent, { "AGENTS.md": "initial" });
    if (winner === "initial") await expect(operation).resolves.toMatchObject({ bundle: { rootPath: "/remote/home" } });
    else await expect(operation).rejects.toMatchObject({ status: 409 });
    expect(f.contents.get("AGENTS.md")).toBe(winner);
    expect(f.remote.write).toHaveBeenCalledExactlyOnceWith("AGENTS.md", "initial", null);
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

  it("excludes only home-level runtime files from remote listing and export", async () => {
    const agent = makeAgent({ instructionsBundleMode: "managed" });
    const list = vi.fn(async (relative = "") => {
      if (relative === ".paperclip-runtime") throw new Error("Must not enumerate provider packs or session state");
      if (!relative) return [{ name: "AGENTS.md", kind: "file", size: 12 }, { name: ".paperclip-runtime", kind: "directory", size: 0 }, { name: "notes", kind: "directory", size: 0 }];
      if (relative === "notes") return [{ name: ".paperclip-runtime", kind: "directory", size: 0 }];
      return [{ name: "user.md", kind: "file", size: 12 }];
    });
    const readBytes = vi.fn(async () => ({ bytes: Buffer.from("instructions"), sha256: "hash" }));
    vi.spyOn(persistentFiles, "persistentAgentFiles").mockResolvedValue({ root: "/remote/home", listPage: async (relative: string) => ({ entries: await list(relative), truncated: false }), stat: async () => ({ kind: "file", size: 12 }), readBytes } as never);
    vi.spyOn(persistentFiles, "seedPersistentAgentHome").mockResolvedValue(undefined);
    vi.spyOn(fileStore, "adoptAgentFiles").mockResolvedValue("/controller/home");
    const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => ({ from: () => ({ where: async () => [agent] }) }) }) };
    const svc = agentInstructionsService(db as never);
    expect((await svc.getBundle(agent)).files.map(file => file.path)).toEqual(["AGENTS.md", "notes/.paperclip-runtime/user.md"]);
    expect((await svc.exportFiles(agent)).files).toEqual({ "AGENTS.md": "instructions", "notes/.paperclip-runtime/user.md": "instructions" });
    expect(list).not.toHaveBeenCalledWith(".paperclip-runtime");
    expect(readBytes).not.toHaveBeenCalledWith(expect.stringMatching(/^\.paperclip-runtime\//));
  });

  it("keeps the configured entry readable beyond a large folder page and warns about partial exports", async () => {
    const agent = makeAgent({ instructionsBundleMode: "managed", instructionsEntryFile: "instructions/AGENTS.md" });
    const entries = Array.from({ length: 1005 }, (_, index) => ({ name: `file-${index}.bin`, kind: "file", size: 2 * 1024 * 1024 }));
    const listPage = vi.fn(async (_relative: string, options: { limit: number }) => ({ entries: entries.slice(0, options.limit), truncated: true }));
    const stat = vi.fn(async () => ({ kind: "file", size: 12 }));
    const readBytes = vi.fn(async () => ({ bytes: Buffer.from("instructions"), sha256: "hash" }));
    vi.spyOn(persistentFiles, "persistentAgentFiles").mockResolvedValue({ root: "/remote/home", listPage, stat, readBytes } as never);
    vi.spyOn(persistentFiles, "seedPersistentAgentHome").mockResolvedValue(undefined);
    vi.spyOn(fileStore, "adoptAgentFiles").mockResolvedValue("/controller/home");
    const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => ({ from: () => ({ where: async () => [agent] }) }) }) };
    const svc = agentInstructionsService(db as never);
    const bundle = await svc.getBundle(agent);
    expect(bundle.files).toHaveLength(1000);
    expect(bundle.files.find(file => file.isEntryFile)).toMatchObject({ path: "instructions/AGENTS.md", isEntryFile: true, editable: true, contentHash: "hash" });
    expect(bundle.warnings).toContainEqual(expect.stringContaining("listing and export are partial"));
    expect((await svc.readFile(agent, "instructions/AGENTS.md")).content).toBe("instructions");
    const exported = await svc.exportFiles(agent);
    expect(exported.files).toEqual({ "instructions/AGENTS.md": "instructions" });
    expect(exported.warnings).toContainEqual(expect.stringContaining("listing and export are partial"));
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(listPage).toHaveBeenCalledWith("", { limit: 999 });
    expect(stat).toHaveBeenCalledWith("instructions/AGENTS.md");
    expect(readBytes).toHaveBeenCalledTimes(3);
    expect(readBytes).toHaveBeenCalledWith("instructions/AGENTS.md");
  });

  it("bounds the entire recursive remote listing rather than each directory separately", async () => {
    const agent = makeAgent({ instructionsBundleMode: "managed" });
    const listPage = vi.fn(async (relative: string, options: { limit: number }) => relative === ""
      ? { entries: [{ name: "notes", kind: "directory", size: 0 }, { name: "later", kind: "directory", size: 0 }], truncated: false }
      : { entries: Array.from({ length: options.limit }, (_, i) => ({ name: `note-${i}.bin`, kind: "file", size: 2 * 1024 * 1024 })), truncated: false });
    vi.spyOn(persistentFiles, "persistentAgentFiles").mockResolvedValue({ root: "/remote/home", listPage, stat: async () => { throw { code: "not_found" }; } } as never);
    vi.spyOn(persistentFiles, "seedPersistentAgentHome").mockResolvedValue(undefined);
    vi.spyOn(fileStore, "adoptAgentFiles").mockResolvedValue("/controller/home");
    const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ select: () => ({ from: () => ({ where: async () => [agent] }) }) }) };
    const bundle = await agentInstructionsService(db as never).getBundle(agent);
    expect(listPage.mock.calls).toEqual([["", { limit: 999 }], ["notes", { limit: 997 }]]);
    expect(bundle.files).toHaveLength(997);
    expect(bundle.warnings).toContainEqual(expect.stringContaining("1,000-entry limit"));
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

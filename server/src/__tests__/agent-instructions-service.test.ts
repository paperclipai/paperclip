import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentInstructionsService } from "../services/agent-instructions.js";
import {
  type DefaultAgentBundleRole,
  type DefaultAgentInstructionsLocale,
  loadDefaultAgentInstructionsBundle,
  loadDefaultAgentInstructionsBundleLocalizationCandidates,
} from "../services/default-agent-instructions.js";

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

  async function setupDefaultManagedBundle(
    locale: DefaultAgentInstructionsLocale,
    adapterConfig: Record<string, unknown> = {},
    role: DefaultAgentBundleRole = "ceo",
  ) {
    const paperclipHome = await makeTempDir(`paperclip-agent-instructions-localize-${locale}-`);
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const svc = agentInstructionsService();
    const files = await loadDefaultAgentInstructionsBundle(role, locale);
    const materialized = await svc.materializeManagedBundle(
      makeAgent(adapterConfig),
      files,
      { entryFile: "AGENTS.md", replaceExisting: true },
    );

    return {
      svc,
      files,
      materialized,
      agent: makeAgent(materialized.adapterConfig),
    };
  }

  async function replaceDefaultBundle(
    svc: ReturnType<typeof agentInstructionsService>,
    agent: TestAgent,
    targetLocale: DefaultAgentInstructionsLocale,
    role: DefaultAgentBundleRole = "ceo",
  ) {
    const candidates = await loadDefaultAgentInstructionsBundleLocalizationCandidates(role);
    const replacementFiles = await loadDefaultAgentInstructionsBundle(role, targetLocale);
    return svc.replaceManagedBundleIfExactMatch(agent, {
      candidates,
      replacement: {
        id: targetLocale,
        files: replacementFiles,
      },
      entryFile: "AGENTS.md",
    });
  }

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

  it("replaces an untouched default managed bundle with the requested locale", async () => {
    const { svc, materialized, agent } = await setupDefaultManagedBundle("en");
    const result = await replaceDefaultBundle(svc, agent, "zh-CN");

    expect(result.changed).toBe(true);
    expect(result.matchedCandidateId).toBe("en");
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ).resolves.toContain("你是 CEO");
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "HEARTBEAT.md"), "utf8"),
    ).resolves.toContain("CEO 心跳检查清单");
  }, 10_000);

  it("restores an untouched Chinese default managed bundle to English", async () => {
    const { svc, materialized, agent } = await setupDefaultManagedBundle("zh-CN");
    const result = await replaceDefaultBundle(svc, agent, "en");

    expect(result.changed).toBe(true);
    expect(result.matchedCandidateId).toBe("zh-CN");
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ).resolves.toContain("You are the CEO.");
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "HEARTBEAT.md"), "utf8"),
    ).resolves.toContain("CEO Heartbeat Checklist");
  }, 10_000);

  it("does not replace a managed default bundle when it already matches the requested locale", async () => {
    const { svc, materialized, agent } = await setupDefaultManagedBundle("zh-CN");
    const before = await fs.readFile(path.join(materialized.bundle.managedRootPath, "AGENTS.md"), "utf8");
    const result = await replaceDefaultBundle(svc, agent, "zh-CN");

    expect(result.changed).toBe(false);
    expect(result.matchedCandidateId).toBe("zh-CN");
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ).resolves.toBe(before);
  }, 10_000);

  it("does not replace edited managed bundle files", async () => {
    const { svc, files: englishFiles, materialized, agent } = await setupDefaultManagedBundle("en");
    await fs.writeFile(
      path.join(materialized.bundle.managedRootPath, "AGENTS.md"),
      `${englishFiles["AGENTS.md"]}\n\nCustom user note.\n`,
      "utf8",
    );

    const result = await replaceDefaultBundle(svc, agent, "zh-CN");

    expect(result.changed).toBe(false);
    expect(result.matchedCandidateId).toBeNull();
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ).resolves.toContain("Custom user note.");
  }, 10_000);

  it("replaces a legacy English CTO managed bundle with the Chinese role bundle", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-legacy-cto-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const svc = agentInstructionsService();
    const legacyCandidate = (await loadDefaultAgentInstructionsBundleLocalizationCandidates("cto"))
      .find((candidate) => candidate.id === "legacy-en:cto-v1");
    expect(legacyCandidate).toBeTruthy();
    const materialized = await svc.materializeManagedBundle(
      makeAgent({}),
      legacyCandidate!.files,
      { entryFile: "AGENTS.md", replaceExisting: true },
    );
    const agent = makeAgent(materialized.adapterConfig);

    const result = await replaceDefaultBundle(svc, agent, "zh-CN", "cto");

    expect(result.changed).toBe(true);
    expect(result.matchedCandidateId).toBe("legacy-en:cto-v1");
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ).resolves.toContain("你是 CTO");
  }, 10_000);

  it("replaces a legacy English CMO managed bundle with the Chinese role bundle", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-legacy-cmo-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const svc = agentInstructionsService();
    const legacyCandidate = (await loadDefaultAgentInstructionsBundleLocalizationCandidates("cmo"))
      .find((candidate) => candidate.id === "legacy-en:cmo-v1" && candidate.files["AGENTS.md"]?.endsWith("\n"));
    expect(legacyCandidate).toBeTruthy();
    const materialized = await svc.materializeManagedBundle(
      makeAgent({}),
      legacyCandidate!.files,
      { entryFile: "AGENTS.md", replaceExisting: true },
    );
    const agent = makeAgent(materialized.adapterConfig);

    const result = await replaceDefaultBundle(svc, agent, "zh-CN", "cmo");

    expect(result.changed).toBe(true);
    expect(result.matchedCandidateId).toBe("legacy-en:cmo-v1");
    await expect(
      fs.readFile(path.join(materialized.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ).resolves.toContain("你是 CMO");
  }, 10_000);

  it("does not replace managed default bundles with missing or extra files", async () => {
    const missing = await setupDefaultManagedBundle("en");
    await fs.rm(path.join(missing.materialized.bundle.managedRootPath, "TOOLS.md"));

    const missingResult = await replaceDefaultBundle(missing.svc, missing.agent, "zh-CN");

    expect(missingResult.changed).toBe(false);
    expect(missingResult.matchedCandidateId).toBeNull();

    const extra = await setupDefaultManagedBundle("en");
    await fs.writeFile(
      path.join(extra.materialized.bundle.managedRootPath, "EXTRA.md"),
      "User-owned note.\n",
      "utf8",
    );

    const extraResult = await replaceDefaultBundle(extra.svc, extra.agent, "zh-CN");

    expect(extraResult.changed).toBe(false);
    expect(extraResult.matchedCandidateId).toBeNull();
    await expect(
      fs.readFile(path.join(extra.materialized.bundle.managedRootPath, "EXTRA.md"), "utf8"),
    ).resolves.toBe("User-owned note.\n");
  }, 10_000);

  it("does not replace external bundles or legacy promptTemplate bundles", async () => {
    const externalRoot = await makeTempDir("paperclip-agent-instructions-localize-external-");
    cleanupDirs.add(externalRoot);
    const englishFiles = await loadDefaultAgentInstructionsBundle("ceo", "en");
    await Promise.all(Object.entries(englishFiles).map(async ([relativePath, content]) => {
      const absolutePath = path.join(externalRoot, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }));

    const externalSvc = agentInstructionsService();
    const externalAgent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const externalResult = await replaceDefaultBundle(externalSvc, externalAgent, "zh-CN");

    expect(externalResult.changed).toBe(false);
    expect(externalResult.matchedCandidateId).toBeNull();
    await expect(fs.readFile(path.join(externalRoot, "AGENTS.md"), "utf8")).resolves.toBe(englishFiles["AGENTS.md"]);

    const legacy = await setupDefaultManagedBundle("en", {
      promptTemplate: "User-authored legacy prompt.",
    });
    const legacyResult = await replaceDefaultBundle(legacy.svc, legacy.agent, "zh-CN");

    expect(legacyResult.changed).toBe(false);
    expect(legacyResult.matchedCandidateId).toBeNull();
    await expect(
      fs.readFile(path.join(legacy.materialized.bundle.managedRootPath, "AGENTS.md"), "utf8"),
    ).resolves.toBe(englishFiles["AGENTS.md"]);
  }, 10_000);

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

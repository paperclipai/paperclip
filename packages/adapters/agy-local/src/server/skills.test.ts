import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGY_WORKSPACE_SKILL_SUBPATH,
  linkSkillDirectory,
  listSkills,
  migrateLegacySkills,
  resolveAgySkillRoot,
  sanitizeAgentIdSegment,
  syncSkills,
  syncSkillsForRun,
  describeRunSkillSync,
  SKILL_SYNC_LOG_PREFIX,
  unlinkSkillDirectory,
} from "./skills.js";

const AGENT_ID = "30223245-91b7-48df-bedb-5f5049b05c38";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agy-skills-test-"));
}

async function writeSkillSource(
  root: string,
  name: string,
  body: string,
  options?: { companyId?: string },
): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const frontmatter = options?.companyId
    ? `---\nname: ${name}\ndescription: ${body}\ncompanyId: ${options.companyId}\n---`
    : `---\nname: ${name}\ndescription: ${body}\n---`;
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `${frontmatter}\n\n${body}\n`,
  );
  return dir;
}

function skillConfig(sourceDirs: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    paperclipRuntimeSkills: Object.entries(sourceDirs).map(([key, source]) => ({
      key,
      runtimeName: key.split("/").pop()!,
      source,
    })),
    ...extra,
  };
}

describe("agy skills path resolution", () => {
  it("agent scope puts skills under a per-agent .agents/skills root", () => {
    const root = resolveAgySkillRoot({ config: {}, agentId: AGENT_ID, homeDir: "/home/u" });
    expect(root.scope).toBe("agent");
    expect(root.addDir).toBe(path.join("/home/u", ".agy-paperclip", "agents", AGENT_ID));
    expect(root.skillsHome).toBe(path.join(root.addDir!, AGY_WORKSPACE_SKILL_SUBPATH));
    expect(AGY_WORKSPACE_SKILL_SUBPATH).toBe(path.join(".agents", "skills"));
  });

  it("agent scope honours an explicit skillsRootPath and makes it agent-specific", () => {
    const root = resolveAgySkillRoot({
      config: { skillsRootPath: "/srv/agy-skills" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.addDir).toBe(path.join(path.resolve("/srv/agy-skills"), AGENT_ID));
    expect(root.skillsHome).toBe(
      path.join(path.resolve("/srv/agy-skills"), AGENT_ID, ".agents", "skills"),
    );
  });

  it("agent scope does not duplicate the agent segment if skillsRootPath already ends with it", () => {
    const customWithAgent = path.join("/srv/agy-skills", AGENT_ID);
    const root = resolveAgySkillRoot({
      config: { skillsRootPath: customWithAgent },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.addDir).toBe(path.resolve(customWithAgent));
    expect(root.skillsHome).toBe(path.join(path.resolve(customWithAgent), ".agents", "skills"));
  });

  it("different agents with identical skillsRootPath resolve to distinct isolated directories", () => {
    const otherAgentId = "98765432-1234-5678-9abc-def012345678";
    const root1 = resolveAgySkillRoot({
      config: { skillsRootPath: "/srv/agy-skills" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    const root2 = resolveAgySkillRoot({
      config: { skillsRootPath: "/srv/agy-skills" },
      agentId: otherAgentId,
      homeDir: "/home/u",
    });
    expect(root1.addDir).not.toBe(root2.addDir);
    expect(root1.skillsHome).not.toBe(root2.skillsHome);
    expect(root1.addDir).toBe(path.join(path.resolve("/srv/agy-skills"), AGENT_ID));
    expect(root2.addDir).toBe(path.join(path.resolve("/srv/agy-skills"), otherAgentId));
  });

  it("records legacySkillsHome when skillsRootPath is set without agentId segment", () => {
    const root = resolveAgySkillRoot({
      config: { skillsRootPath: "/srv/agy-skills" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.legacySkillsHome).toBe(
      path.join(path.resolve("/srv/agy-skills"), ".agents", "skills"),
    );
  });

  it("does not set legacySkillsHome when skillsRootPath already ends with agentId segment", () => {
    const root = resolveAgySkillRoot({
      config: { skillsRootPath: path.join("/srv/agy-skills", AGENT_ID) },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.legacySkillsHome).toBeUndefined();
  });

  it("does not set legacySkillsHome when skillsRootPath is not configured", () => {
    const root = resolveAgySkillRoot({
      config: {},
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.legacySkillsHome).toBeUndefined();
  });

  it("global scope falls back to per-agent scope with a warning to protect isolation", () => {
    const root = resolveAgySkillRoot({
      config: { skillsScope: "global" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.scope).toBe("agent");
    expect(root.addDir).toBe(path.join("/home/u", ".agy-paperclip", "agents", AGENT_ID));
    expect(root.skillsHome).toBe(
      path.join("/home/u", ".agy-paperclip", "agents", AGENT_ID, ".agents", "skills"),
    );
    expect(root.warnings?.[0]).toMatch(/disabled to prevent cross-company skill leakage/);
  });

  it("global scope honours an explicit skillsRootPath when provided", () => {
    const root = resolveAgySkillRoot({
      config: { skillsScope: "global", skillsRootPath: "/srv/agy-skills" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.scope).toBe("agent");
    expect(root.addDir).toBe(path.join(path.resolve("/srv/agy-skills"), AGENT_ID));
    expect(root.skillsHome).toBe(
      path.join(path.resolve("/srv/agy-skills"), AGENT_ID, ".agents", "skills"),
    );
    expect(root.warnings?.[0]).toMatch(/disabled to prevent cross-company skill leakage/);
  });

  it("never resolves to ~/.gemini/skills or ~/.gemini/config/skills", () => {
    const deadSkills = path.join("/home/u", ".gemini", "skills");
    const sharedConfigSkills = path.join("/home/u", ".gemini", "config", "skills");
    for (const config of [{}, { skillsScope: "global" }, { skillsScope: "GLOBAL" }]) {
      const root = resolveAgySkillRoot({ config, agentId: AGENT_ID, homeDir: "/home/u" });
      expect(root.skillsHome).not.toBe(deadSkills);
      expect(root.skillsHome).not.toBe(sharedConfigSkills);
    }
  });

  it("an unrecognized skillsScope falls back to per-agent rather than the shared root", () => {
    const root = resolveAgySkillRoot({
      config: { skillsScope: "workspace" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.scope).toBe("agent");
  });

  it("agent ids are reduced to a single safe path segment", () => {
    expect(sanitizeAgentIdSegment(AGENT_ID)).toBe(AGENT_ID);
    expect(sanitizeAgentIdSegment("../../etc")).toBe("..-..-etc");
    expect(sanitizeAgentIdSegment("..")).toBe("unknown-agent");
    expect(sanitizeAgentIdSegment("  ")).toBe("unknown-agent");
    expect(sanitizeAgentIdSegment("a/b/c")).not.toContain(path.sep);
  });
});

describe("listSkills and syncSkills", () => {
  it("listSkills reports desired-but-unsynced skills as missing", async () => {
    const tmp = await makeTempDir();
    try {
      const src = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const config = skillConfig(
        { "paperclipai/paperclip/alpha": src },
        {
          skillsRootPath: path.join(tmp, "root"),
          paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
        },
      );
      const snapshot = await listSkills({
        agentId: AGENT_ID,
        companyId: "c1",
        adapterType: "agy_local",
        config,
      });

      expect(snapshot.adapterType).toBe("agy_local");
      expect(snapshot.supported).toBe(true);
      expect(snapshot.mode).toBe("persistent");
      const alpha = snapshot.entries.find((entry) => entry.runtimeName === "alpha");
      expect(alpha?.desired).toBe(true);
      expect(alpha?.state).toBe("missing");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkills links desired skills into the agy skills home", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const beta = await writeSkillSource(path.join(tmp, "src"), "beta", "Beta skill");
      const rootPath = path.join(tmp, "root");

      const config = skillConfig(
        { "paperclipai/paperclip/alpha": alpha, "paperclipai/paperclip/beta": beta },
        { skillsRootPath: rootPath },
      );
      const snapshot = await syncSkills(
        { agentId: AGENT_ID, companyId: "c1", adapterType: "agy_local", config },
        ["paperclipai/paperclip/alpha"],
      );

      const skillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      expect(await fs.realpath(path.join(skillsHome, "alpha"))).toBe(await fs.realpath(alpha));
      expect(await fs.readFile(path.join(skillsHome, "alpha", "SKILL.md"), "utf8")).toMatch(/Alpha skill/);
      expect(await fs.lstat(path.join(skillsHome, "beta")).catch(() => null)).toBeNull();

      const alphaEntry = snapshot.entries.find((entry) => entry.runtimeName === "alpha");
      expect(alphaEntry?.state).toBe("installed");
      expect(alphaEntry?.managed).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkills removes a link it owns once the skill is no longer desired", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const rootPath = path.join(tmp, "root");
      const ctx = {
        agentId: AGENT_ID,
        companyId: "c1",
        adapterType: "agy_local",
        config: skillConfig({ "paperclipai/paperclip/alpha": alpha }, { skillsRootPath: rootPath }),
      };

      await syncSkills(ctx, ["paperclipai/paperclip/alpha"]);
      await syncSkills(ctx, []);

      const skillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      expect(await fs.lstat(path.join(skillsHome, "alpha")).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkills leaves an unmanaged directory in the skills home alone", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const rootPath = path.join(tmp, "root");
      const skillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");

      await writeSkillSource(skillsHome, "alpha", "Operator's own alpha");

      const snapshot = await syncSkills(
        {
          agentId: AGENT_ID,
          companyId: "c1",
          adapterType: "agy_local",
          config: skillConfig({ "paperclipai/paperclip/alpha": alpha }, { skillsRootPath: rootPath }),
        },
        ["paperclipai/paperclip/alpha"],
      );

      expect(await fs.readFile(path.join(skillsHome, "alpha", "SKILL.md"), "utf8")).toMatch(
        /Operator's own alpha/,
      );
      const entry = snapshot.entries.find((item) => item.runtimeName === "alpha");
      expect(entry?.state).toBe("external");
      expect(snapshot.warnings.some((warning) => warning.includes("alpha"))).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkills skips a skill whose source never materialized", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "root");
      const config = {
        skillsRootPath: rootPath,
        paperclipRuntimeSkills: [
          {
            key: "paperclipai/paperclip/ghost",
            runtimeName: "ghost",
            source: path.join(tmp, "src", "ghost"),
            sourceStatus: "missing",
            missingDetail: "version snapshot deleted",
          },
        ],
      };

      const snapshot = await syncSkills(
        { agentId: AGENT_ID, companyId: "c1", adapterType: "agy_local", config },
        ["paperclipai/paperclip/ghost"],
      );

      const skillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      expect(await fs.lstat(path.join(skillsHome, "ghost")).catch(() => null)).toBeNull();
      expect(snapshot.entries.find((entry) => entry.runtimeName === "ghost")?.state).toBe("missing");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("global scope warns that global scope is disabled for isolation", async () => {
    const snapshot = await listSkills({
      agentId: AGENT_ID,
      companyId: "c1",
      adapterType: "agy_local",
      config: { skillsScope: "global", paperclipRuntimeSkills: [] },
    });
    expect(
      snapshot.warnings.some((warning) =>
        warning.includes("disabled to prevent cross-company skill leakage"),
      ),
    ).toBe(true);
  });

  it("listSkills migrates existing custom skills from legacy un-scoped root to agent-specific root", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "custom-root");
      const legacySkillsDir = path.join(rootPath, ".agents", "skills");
      await writeSkillSource(legacySkillsDir, "custom-legacy", "Legacy operator skill", { companyId: "c1" });

      const config = {
        skillsRootPath: rootPath,
      };

      const snapshot = await listSkills({
        agentId: AGENT_ID,
        companyId: "c1",
        adapterType: "agy_local",
        config,
      });

      const newSkillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      expect(
        await fs.readFile(path.join(newSkillsHome, "custom-legacy", "SKILL.md"), "utf8"),
      ).toMatch(/Legacy operator skill/);
      expect(await fs.lstat(path.join(legacySkillsDir, "custom-legacy")).catch(() => null)).toBeNull();

      const customEntry = snapshot.entries.find((entry) => entry.runtimeName === "custom-legacy");
      expect(customEntry?.state).toBe("external");
      expect(customEntry?.managed).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkills migrates existing custom skills and preserves them alongside synced skills", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const rootPath = path.join(tmp, "custom-root");
      const legacySkillsDir = path.join(rootPath, ".agents", "skills");
      await writeSkillSource(legacySkillsDir, "custom-legacy", "Legacy operator skill", { companyId: "c1" });

      const config = skillConfig(
        { "paperclipai/paperclip/alpha": alpha },
        { skillsRootPath: rootPath },
      );

      const snapshot = await syncSkills(
        { agentId: AGENT_ID, companyId: "c1", adapterType: "agy_local", config },
        ["paperclipai/paperclip/alpha"],
      );

      const newSkillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      expect(
        await fs.readFile(path.join(newSkillsHome, "custom-legacy", "SKILL.md"), "utf8"),
      ).toMatch(/Legacy operator skill/);
      expect(
        await fs.readFile(path.join(newSkillsHome, "alpha", "SKILL.md"), "utf8"),
      ).toMatch(/Alpha skill/);
      expect(await fs.lstat(legacySkillsDir).catch(() => null)).toBeNull();

      const alphaEntry = snapshot.entries.find((entry) => entry.runtimeName === "alpha");
      expect(alphaEntry?.state).toBe("installed");
      expect(alphaEntry?.managed).toBe(true);

      const customEntry = snapshot.entries.find((entry) => entry.runtimeName === "custom-legacy");
      expect(customEntry?.state).toBe("external");
      expect(customEntry?.managed).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not migrate skills belonging to another company when agents share skillsRootPath", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "shared-custom-root");
      const legacySkillsDir = path.join(rootPath, ".agents", "skills");
      await fs.mkdir(legacySkillsDir, { recursive: true });

      // Create company-1 skill source and company-2 skill source
      const c1Source = await writeSkillSource(path.join(tmp, "skills", "c1"), "alpha", "Company 1 Alpha");
      const c2Source = await writeSkillSource(path.join(tmp, "skills", "c2"), "beta", "Company 2 Beta");

      // In legacy root, symlinks existed for both
      await linkSkillDirectory(c1Source, path.join(legacySkillsDir, "alpha"));
      await linkSkillDirectory(c2Source, path.join(legacySkillsDir, "beta"));

      // Also create custom directories with explicit company metadata
      await writeSkillSource(legacySkillsDir, "c1-custom", "Custom for C1", { companyId: "c1" });
      await writeSkillSource(legacySkillsDir, "c2-custom", "Custom for C2", { companyId: "c2" });

      const agent1Id = "agent-c1-0001";
      const agent2Id = "agent-c2-0002";

      const c1Config = skillConfig(
        { "paperclipai/paperclip/alpha": c1Source },
        { skillsRootPath: rootPath },
      );
      const c2Config = skillConfig(
        { "paperclipai/paperclip/beta": c2Source },
        { skillsRootPath: rootPath },
      );

      // Agent 1 (Company 1) syncs skills
      const snap1 = await syncSkills(
        { agentId: agent1Id, companyId: "c1", adapterType: "agy_local", config: c1Config },
        ["paperclipai/paperclip/alpha"],
      );

      const agent1SkillsHome = path.join(rootPath, agent1Id, ".agents", "skills");
      // Agent 1 gets alpha and c1-custom
      expect(await fs.lstat(path.join(agent1SkillsHome, "alpha")).catch(() => null)).not.toBeNull();
      expect(await fs.lstat(path.join(agent1SkillsHome, "c1-custom")).catch(() => null)).not.toBeNull();

      // Agent 1 MUST NOT get beta or c2-custom
      expect(await fs.lstat(path.join(agent1SkillsHome, "beta")).catch(() => null)).toBeNull();
      expect(await fs.lstat(path.join(agent1SkillsHome, "c2-custom")).catch(() => null)).toBeNull();

      // Legacy root MUST still contain beta and c2-custom!
      expect(await fs.lstat(path.join(legacySkillsDir, "beta")).catch(() => null)).not.toBeNull();
      expect(await fs.lstat(path.join(legacySkillsDir, "c2-custom")).catch(() => null)).not.toBeNull();

      // And legacy root MUST NOT contain alpha or c1-custom anymore
      expect(await fs.lstat(path.join(legacySkillsDir, "alpha")).catch(() => null)).toBeNull();
      expect(await fs.lstat(path.join(legacySkillsDir, "c1-custom")).catch(() => null)).toBeNull();

      // Now Agent 2 (Company 2) syncs skills
      const snap2 = await syncSkills(
        { agentId: agent2Id, companyId: "c2", adapterType: "agy_local", config: c2Config },
        ["paperclipai/paperclip/beta"],
      );

      const agent2SkillsHome = path.join(rootPath, agent2Id, ".agents", "skills");
      // Agent 2 gets beta and c2-custom
      expect(await fs.lstat(path.join(agent2SkillsHome, "beta")).catch(() => null)).not.toBeNull();
      expect(await fs.lstat(path.join(agent2SkillsHome, "c2-custom")).catch(() => null)).not.toBeNull();

      // Agent 2 MUST NOT have c1 skills
      expect(await fs.lstat(path.join(agent2SkillsHome, "alpha")).catch(() => null)).toBeNull();
      expect(await fs.lstat(path.join(agent2SkillsHome, "c1-custom")).catch(() => null)).toBeNull();

      // Legacy skills root should now be completely migrated and cleaned up
      expect(await fs.lstat(legacySkillsDir).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves another company's symlink when both companies have a skill with the same runtime name", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "shared-custom-root");
      const legacySkillsDir = path.join(rootPath, ".agents", "skills");
      await fs.mkdir(legacySkillsDir, { recursive: true });

      const c1Source = await writeSkillSource(path.join(tmp, "c1-src"), "calc", "C1 Calculator");
      const c2Source = await writeSkillSource(path.join(tmp, "c2-src"), "calc", "C2 Calculator");

      // In legacy, the symlink pointed to C2's source
      await linkSkillDirectory(c2Source, path.join(legacySkillsDir, "calc"));

      const agent1Id = "agent-c1-0001";
      const agent2Id = "agent-c2-0002";

      const c1Config = skillConfig(
        { "paperclipai/paperclip/calc": c1Source },
        { skillsRootPath: rootPath },
      );
      const c2Config = skillConfig(
        { "paperclipai/paperclip/calc": c2Source },
        { skillsRootPath: rootPath },
      );

      // Agent 1 (Company 1) syncs
      await syncSkills(
        { agentId: agent1Id, companyId: "c1", adapterType: "agy_local", config: c1Config },
        ["paperclipai/paperclip/calc"],
      );

      const agent1SkillsHome = path.join(rootPath, agent1Id, ".agents", "skills");
      // Agent 1 gets a fresh link pointing to C1's source
      expect(await fs.realpath(path.join(agent1SkillsHome, "calc"))).toBe(await fs.realpath(c1Source));

      // The legacy link still points to C2's source!
      expect(await fs.readlink(path.join(legacySkillsDir, "calc"))).toBe(c2Source);

      // Agent 2 (Company 2) syncs
      await syncSkills(
        { agentId: agent2Id, companyId: "c2", adapterType: "agy_local", config: c2Config },
        ["paperclipai/paperclip/calc"],
      );

      const agent2SkillsHome = path.join(rootPath, agent2Id, ".agents", "skills");
      expect(await fs.realpath(path.join(agent2SkillsHome, "calc"))).toBe(await fs.realpath(c2Source));

      // Now legacy is cleaned up
      expect(await fs.lstat(legacySkillsDir).catch(() => null)).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves unmarked skills in shared legacy root across multiple companies", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "shared-custom-root");
      const legacySkillsDir = path.join(rootPath, ".agents", "skills");
      await writeSkillSource(legacySkillsDir, "unmarked-shared", "Unmarked shared skill");

      const agent1Id = "agent-c1-0001";
      const agent2Id = "agent-c2-0002";

      const c1Config = skillConfig({}, { skillsRootPath: rootPath });
      const c2Config = skillConfig({}, { skillsRootPath: rootPath });

      // Company 1 syncs skills
      await syncSkills(
        { agentId: agent1Id, companyId: "c1", adapterType: "agy_local", config: c1Config },
        [],
      );

      const agent1SkillsHome = path.join(rootPath, agent1Id, ".agents", "skills");
      // Unmarked skill in shared legacy root must NOT be copied into Company 1's agent directory
      expect(
        await fs.lstat(path.join(agent1SkillsHome, "unmarked-shared")).catch(() => null),
      ).toBeNull();

      // Legacy root MUST still contain unmarked-shared untouched
      expect(await fs.lstat(path.join(legacySkillsDir, "unmarked-shared")).catch(() => null)).not.toBeNull();

      // Company 2 syncs skills
      await syncSkills(
        { agentId: agent2Id, companyId: "c2", adapterType: "agy_local", config: c2Config },
        [],
      );

      const agent2SkillsHome = path.join(rootPath, agent2Id, ".agents", "skills");
      // Unmarked skill in shared legacy root must NOT be copied into Company 2's agent directory
      expect(
        await fs.lstat(path.join(agent2SkillsHome, "unmarked-shared")).catch(() => null),
      ).toBeNull();

      // Still preserved untouched in legacy root
      expect(await fs.lstat(path.join(legacySkillsDir, "unmarked-shared")).catch(() => null)).not.toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("syncSkillsForRun and receipts", () => {
  it("syncSkillsForRun materializes skills from run config with no prior sync", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const rootPath = path.join(tmp, "root");

      const result = await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(
          { "paperclipai/paperclip/alpha": alpha },
          {
            skillsRootPath: rootPath,
            paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
          },
        ),
      });

      const skillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      expect(await fs.readFile(path.join(skillsHome, "alpha", "SKILL.md"), "utf8")).toMatch(/Alpha skill/);
      expect(result.root.addDir).toBe(path.join(path.resolve(rootPath), AGENT_ID));
      expect(result.snapshot?.entries.find((entry) => entry.runtimeName === "alpha")?.state).toBe(
        "installed",
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkillsForRun drops a link once the run config stops asking for it", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const rootPath = path.join(tmp, "root");
      const sources = { "paperclipai/paperclip/alpha": alpha };

      await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(sources, {
          skillsRootPath: rootPath,
          paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
        }),
      });
      await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(sources, {
          skillsRootPath: rootPath,
          paperclipSkillSync: { desiredSkills: [] },
        }),
      });

      expect(
        await fs.lstat(path.join(rootPath, AGENT_ID, ".agents", "skills", "alpha")).catch(() => null),
      ).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkillsForRun with skillsScope global syncs to agent-isolated root and warns", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const rootPath = path.join(tmp, "root");
      const result = await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(
          { "paperclipai/paperclip/alpha": alpha },
          {
            skillsScope: "global",
            skillsRootPath: rootPath,
            paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
          },
        ),
      });

      expect(result.root.scope).toBe("agent");
      expect(result.snapshot).not.toBeNull();
      expect(
        result.snapshot?.entries.find((entry) => entry.runtimeName === "alpha")?.state,
      ).toBe("installed");
      expect(
        result.warnings.some((w) => w.includes("disabled to prevent cross-company skill leakage")),
      ).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("describeRunSkillSync names each installed skill and its version", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "root");
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

      const sync = await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: {
          skillsRootPath: rootPath,
          paperclipRuntimeSkills: [
            {
              key: "paperclipai/paperclip/alpha",
              runtimeName: "alpha",
              source: alpha,
              versionId: "b9e4beac-92a0-4ff2-9f57-c9e66c1655c2",
            },
          ],
          paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
        },
      });

      const lines = describeRunSkillSync(sync);
      expect(lines.every((line) => line.startsWith(SKILL_SYNC_LOG_PREFIX))).toBe(true);
      expect(lines[0]).toMatch(/1\/1 desired skill\(s\) installed/);
      expect(lines[0]).toContain(sync.root.skillsHome);
      expect(lines[1]).toMatch(/installed alpha version=b9e4beac key=paperclipai\/paperclip\/alpha/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("describeRunSkillSync reports an unpinned version rather than omitting the skill", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "root");
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

      const sync = await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(
          { "paperclipai/paperclip/alpha": alpha },
          {
            skillsRootPath: rootPath,
            paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
          },
        ),
      });

      expect(describeRunSkillSync(sync).join("\n")).toMatch(/installed alpha version=unpinned/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("describeRunSkillSync distinguishes 'nothing assigned' from 'never ran'", () => {
    const lines = describeRunSkillSync({
      root: resolveAgySkillRoot({ config: {}, agentId: AGENT_ID, homeDir: "/home/u" }),
      snapshot: null,
      desiredSkills: [],
      warnings: [],
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/nothing to deliver — no skills are assigned to this agent/);
  });

  it("describeRunSkillSync reports nothing to deliver when desiredSkills is empty even with skillsScope global", () => {
    const lines = describeRunSkillSync({
      root: resolveAgySkillRoot({
        config: { skillsScope: "global" },
        agentId: AGENT_ID,
        homeDir: "/home/u",
      }),
      snapshot: null,
      desiredSkills: [],
      warnings: [],
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/nothing to deliver — no skills are assigned to this agent/);
    expect(lines[0]).toContain(
      path.join("/home/u", ".agy-paperclip", "agents", AGENT_ID, ".agents", "skills"),
    );
  });

  it("describeRunSkillSync flags a desired skill Paperclip never provided an entry for", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "root");
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

      const sync = await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(
          { "paperclipai/paperclip/alpha": alpha },
          {
            skillsRootPath: rootPath,
            paperclipSkillSync: {
              desiredSkills: ["paperclipai/paperclip/alpha", "paperclipai/paperclip/beta"],
            },
          },
        ),
      });

      const joined = describeRunSkillSync(sync).join("\n");
      expect(joined).toMatch(/1 not installed/);
      expect(joined).toMatch(/missing key=paperclipai\/paperclip\/beta/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkillsForRun migrates custom skills from legacy root even with no desired skills", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "custom-root");
      const legacySkillsDir = path.join(rootPath, ".agents", "skills");
      await writeSkillSource(legacySkillsDir, "custom-legacy", "Legacy operator skill", { companyId: "c1" });

      const result = await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(
          {},
          {
            skillsRootPath: rootPath,
            paperclipSkillSync: { desiredSkills: [] },
          },
        ),
      });

      const newSkillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      expect(
        await fs.readFile(path.join(newSkillsHome, "custom-legacy", "SKILL.md"), "utf8"),
      ).toMatch(/Legacy operator skill/);
      expect(await fs.lstat(legacySkillsDir).catch(() => null)).toBeNull();
      expect(result.snapshot).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("migrateLegacySkills does not overwrite skills already in agent-specific home", async () => {
    const tmp = await makeTempDir();
    try {
      const rootPath = path.join(tmp, "custom-root");
      const legacySkillsDir = path.join(rootPath, ".agents", "skills");
      const newSkillsHome = path.join(rootPath, AGENT_ID, ".agents", "skills");
      await writeSkillSource(legacySkillsDir, "shared-skill", "Old legacy version");
      await writeSkillSource(newSkillsHome, "shared-skill", "New agent version");

      const root = resolveAgySkillRoot({
        config: { skillsRootPath: rootPath },
        agentId: AGENT_ID,
      });

      await migrateLegacySkills(root);

      expect(
        await fs.readFile(path.join(newSkillsHome, "shared-skill", "SKILL.md"), "utf8"),
      ).toMatch(/New agent version/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  describe("unlinkSkillDirectory", () => {
    it("unlinks a symbolic link without affecting the target directory", async () => {
      const tmp = await makeTempDir();
      try {
        const sourceDir = path.join(tmp, "source-skill");
        await writeSkillSource(tmp, "source-skill", "Skill content");
        const linkPath = path.join(tmp, "linked-skill");
        await linkSkillDirectory(sourceDir, linkPath);

        expect(await fs.lstat(linkPath).then((s) => s.isSymbolicLink())).toBe(true);

        await unlinkSkillDirectory(linkPath);

        expect(await fs.lstat(linkPath).catch(() => null)).toBeNull();
        expect(await fs.readFile(path.join(sourceDir, "SKILL.md"), "utf8")).toContain("Skill content");
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it("refuses to delete a real directory and leaves its contents intact", async () => {
      const tmp = await makeTempDir();
      try {
        const realDir = path.join(tmp, "real-skill");
        await writeSkillSource(tmp, "real-skill", "Real skill content");

        await expect(unlinkSkillDirectory(realDir)).rejects.toThrow(/Cannot unlink non-symlink/);

        // Contents must remain completely intact
        expect(await fs.readFile(path.join(realDir, "SKILL.md"), "utf8")).toContain("Real skill content");
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });
});


import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGY_WORKSPACE_SKILL_SUBPATH,
  listSkills,
  resolveAgySkillRoot,
  sanitizeAgentIdSegment,
  syncSkills,
  syncSkillsForRun,
  describeRunSkillSync,
  SKILL_SYNC_LOG_PREFIX,
} from "./skills.js";

const AGENT_ID = "30223245-91b7-48df-bedb-5f5049b05c38";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agy-skills-test-"));
}

async function writeSkillSource(root: string, name: string, body: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`,
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

  it("agent scope honours an explicit skillsRootPath and appends .agents/skills to it", () => {
    const root = resolveAgySkillRoot({
      config: { skillsRootPath: "/srv/agy-skills" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.addDir).toBe(path.resolve("/srv/agy-skills"));
    expect(root.skillsHome).toBe(path.join("/srv/agy-skills", ".agents", "skills"));
  });

  it("global scope targets agy's config skills dir and needs no --add-dir", () => {
    const root = resolveAgySkillRoot({
      config: { skillsScope: "global", skillsRootPath: "/ignored" },
      agentId: AGENT_ID,
      homeDir: "/home/u",
    });
    expect(root.scope).toBe("global");
    expect(root.skillsHome).toBe(path.join("/home/u", ".gemini", "config", "skills"));
    expect(root.addDir).toBeNull();
  });

  it("never resolves to ~/.gemini/skills, which agy does not scan", () => {
    const dead = path.join("/home/u", ".gemini", "skills");
    for (const config of [{}, { skillsScope: "global" }, { skillsScope: "GLOBAL" }]) {
      const root = resolveAgySkillRoot({ config, agentId: AGENT_ID, homeDir: "/home/u" });
      expect(root.skillsHome).not.toBe(dead);
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

      const skillsHome = path.join(rootPath, ".agents", "skills");
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

      const skillsHome = path.join(rootPath, ".agents", "skills");
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
      const skillsHome = path.join(rootPath, ".agents", "skills");

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

      const skillsHome = path.join(rootPath, ".agents", "skills");
      expect(await fs.lstat(path.join(skillsHome, "ghost")).catch(() => null)).toBeNull();
      expect(snapshot.entries.find((entry) => entry.runtimeName === "ghost")?.state).toBe("missing");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("global scope warns that the skills home is shared across agents", async () => {
    const snapshot = await listSkills({
      agentId: AGENT_ID,
      companyId: "c1",
      adapterType: "agy_local",
      config: { skillsScope: "global", paperclipRuntimeSkills: [] },
    });
    expect(snapshot.warnings.some((warning) => warning.includes("shares"))).toBe(true);
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

      const skillsHome = path.join(rootPath, ".agents", "skills");
      expect(await fs.readFile(path.join(skillsHome, "alpha", "SKILL.md"), "utf8")).toMatch(/Alpha skill/);
      expect(result.root.addDir).toBe(path.resolve(rootPath));
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
        await fs.lstat(path.join(rootPath, ".agents", "skills", "alpha")).catch(() => null),
      ).toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("syncSkillsForRun leaves the shared global root untouched", async () => {
    const tmp = await makeTempDir();
    try {
      const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
      const result = await syncSkillsForRun({
        agentId: AGENT_ID,
        companyId: "c1",
        config: skillConfig(
          { "paperclipai/paperclip/alpha": alpha },
          {
            skillsScope: "global",
            paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
          },
        ),
      });

      expect(result.snapshot).toBeNull();
      expect(result.root.scope).toBe("global");
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

  it("describeRunSkillSync explains why global scope did not sync", () => {
    const lines = describeRunSkillSync({
      root: resolveAgySkillRoot({ config: { skillsScope: "global" }, agentId: AGENT_ID, homeDir: "/home/u" }),
      snapshot: null,
      desiredSkills: ["paperclipai/paperclip/alpha"],
      warnings: [],
    });
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/skipped — skillsScope is "global"/);
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
});

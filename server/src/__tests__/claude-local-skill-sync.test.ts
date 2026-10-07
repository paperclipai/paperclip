import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listClaudeSkills,
  syncClaudeSkills,
} from "@paperclipai/adapter-claude-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSkillDir(root: string, name: string) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
  return skillDir;
}

describe("claude local skill sync", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const createAgentKey = "paperclipai/paperclip/paperclip-create-agent";
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    // Keep an inherited shell value from changing which directory a test reads.
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("keeps the operational Paperclip skill configured when no explicit selection exists", async () => {
    const snapshot = await listClaudeSkills({
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {},
    });

    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.desiredSkills).toEqual([paperclipKey, "paperclipai/paperclip/complain", "paperclipai/paperclip/suggestion-box"]);
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === createAgentKey)?.state).toBe("available");
  });

  it("respects an explicit desired skill list without mutating a persistent home", async () => {
    const snapshot = await syncClaudeSkills({
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        paperclipSkillSync: {
          desiredSkills: [paperclipKey],
        },
      },
    }, [paperclipKey]);

    expect(snapshot.desiredSkills).toContain(paperclipKey);
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === createAgentKey)?.state).toBe("available");
  });

  it("normalizes legacy flat Paperclip skill refs to canonical keys", async () => {
    const snapshot = await listClaudeSkills({
      agentId: "agent-3",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    });

    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.desiredSkills).toContain(paperclipKey);
    expect(snapshot.desiredSkills).not.toContain("paperclip");
    expect(snapshot.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("configured");
    expect(snapshot.entries.find((entry) => entry.key === "paperclip")).toBeUndefined();
  });

  it("shows host-level user-installed Claude skills as read-only external entries", async () => {
    const home = await makeTempDir("paperclip-claude-user-skills-");
    cleanupDirs.add(home);
    await createSkillDir(path.join(home, ".claude", "skills"), "crack-python");

    const snapshot = await listClaudeSkills({
      agentId: "agent-4",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        env: {
          HOME: home,
        },
      },
    });

    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "crack-python",
      runtimeName: "crack-python",
      state: "external",
      managed: false,
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.claude/skills",
      readOnly: true,
      detail: "Installed outside Paperclip management in the Claude skills home.",
    }));
  });

  it("prefers CLAUDE_CONFIG_DIR in the agent env over the host value", async () => {
    const home = await makeTempDir("paperclip-claude-home-");
    const configDir = await makeTempDir("paperclip-claude-config-dir-");
    cleanupDirs.add(home);
    cleanupDirs.add(configDir);
    const hostConfigDir = await makeTempDir("paperclip-claude-host-config-dir-");
    cleanupDirs.add(hostConfigDir);
    await createSkillDir(path.join(home, ".claude", "skills"), "home-only-skill");
    await createSkillDir(path.join(configDir, "skills"), "config-dir-skill");
    await createSkillDir(path.join(hostConfigDir, "skills"), "host-only-skill");
    vi.stubEnv("CLAUDE_CONFIG_DIR", hostConfigDir);

    const snapshot = await listClaudeSkills({
      agentId: "agent-5",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        env: {
          HOME: home,
          CLAUDE_CONFIG_DIR: configDir,
        },
      },
    });

    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "config-dir-skill",
      state: "external",
      origin: "user_installed",
      locationLabel: path.join(configDir, "skills"),
    }));
    expect(snapshot.entries.find((entry) => entry.key === "home-only-skill")).toBeUndefined();
    expect(snapshot.entries.find((entry) => entry.key === "host-only-skill")).toBeUndefined();
  });

  it("resolves a relative CLAUDE_CONFIG_DIR against the configured cwd", async () => {
    const cwd = await makeTempDir("paperclip-claude-cwd-");
    cleanupDirs.add(cwd);
    await createSkillDir(path.join(cwd, "claude-config", "skills"), "relative-config-dir-skill");

    const snapshot = await listClaudeSkills({
      agentId: "agent-7",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {
        cwd,
        env: {
          CLAUDE_CONFIG_DIR: "./claude-config",
        },
      },
    });

    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "relative-config-dir-skill",
      state: "external",
      locationLabel: path.join(cwd, "claude-config", "skills"),
    }));
  });

  it("reads user-installed Claude skills from the host CLAUDE_CONFIG_DIR", async () => {
    const configDir = await makeTempDir("paperclip-claude-host-config-dir-");
    cleanupDirs.add(configDir);
    await createSkillDir(path.join(configDir, "skills"), "host-config-dir-skill");
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);

    const snapshot = await listClaudeSkills({
      agentId: "agent-6",
      companyId: "company-1",
      adapterType: "claude_local",
      config: {},
    });

    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "host-config-dir-skill",
      state: "external",
      locationLabel: path.join(configDir, "skills"),
    }));
  });
});

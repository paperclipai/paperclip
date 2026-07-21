import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createStateRepoService } from "../services/state-repo.js";

const exec = promisify(execFile);

describe("state repo service", () => {
  it("commits attributed state, mirrors, bundles, restores, and blocks secrets", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-state-repo-"));
    const instance = path.join(homeDir, "instances", "test");
    const instructions = path.join(instance, "companies", "company-1", "agents", "agent-1", "instructions");
    const skill = path.join(instance, "skills", "company-1", "skill-1");
    await fs.mkdir(instructions, { recursive: true });
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(path.join(instructions, "AGENTS.md"), "# Initial\n");
    await fs.writeFile(path.join(skill, "SKILL.md"), "# Skill\n");
    const remote = path.join(homeDir, "remote.git");
    await exec("git", ["init", "--bare", remote]);
    const service = createStateRepoService({
      homeDir,
      instanceId: "test",
      markerDir: path.join(instance, "health"),
      resolveMirror: async () => ({ url: remote }),
    });
    await service.commit({ companyId: "company-1", actor: { name: "Fable", email: "agent+fable@paperclip.invalid" }, message: "agent-instructions: update Fable" });
    await fs.writeFile(path.join(skill, "SKILL.md"), "# Updated skill\n");
    await service.commit({ companyId: "company-1", actor: { name: "Board User", email: "user+board@paperclip.invalid" }, message: "skill: update skill-1" });
    await service.testMirror("company-1");
    const repo = service.repoPathFor("company-1");
    const log = (await exec("git", ["--git-dir", repo, "log", "--format=%an|%ae|%cn|%s"])).stdout;
    expect(log).toContain("Board User|user+board@paperclip.invalid|paperclip-state-bot|skill: update skill-1");
    expect(log).toContain("Fable|agent+fable@paperclip.invalid|paperclip-state-bot|agent-instructions: update Fable");
    expect((await exec("git", ["--git-dir", remote, "rev-parse", "main"])).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    const bundle = path.join(homeDir, "state.bundle");
    await service.exportBundle("company-1", bundle);
    await fs.rm(path.join(instance, "companies", "company-1"), { recursive: true, force: true });
    await fs.rm(path.join(instance, "skills", "company-1"), { recursive: true, force: true });
    const restored = await service.restore("company-1", bundle);
    expect(restored.restored).toContain("agents/agent-1/AGENTS.md");
    expect(await fs.readFile(path.join(instructions, "AGENTS.md"), "utf8")).toBe("# Initial\n");
    expect(await fs.readFile(path.join(skill, "SKILL.md"), "utf8")).toBe("# Updated skill\n");
    await fs.writeFile(path.join(instructions, "AGENTS.md"), "ghp_abcdefghijklmnopqrstuvwxyz123456\n");
    await expect(service.commit({ companyId: "company-1", actor: { name: "Fable", email: "agent+fable@paperclip.invalid" }, message: "bad" })).rejects.toThrow("secret scan blocked");
  });

  it("debounces Claude memory changes into an automatic commit", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-state-memory-"));
    const instance = path.join(homeDir, "instances", "test");
    const memory = path.join(homeDir, ".claude", "projects", "workspace", "memory");
    await fs.mkdir(memory, { recursive: true });
    await fs.writeFile(path.join(memory, "MEMORY.md"), "# Initial\n");
    const service = createStateRepoService({
      homeDir,
      instanceId: "test",
      markerDir: path.join(instance, "health"),
      resolveMemorySources: async () => [{ agentId: "agent-1", root: memory }],
    });
    await service.commit({ companyId: "company-1", actor: { name: "Setup", email: "setup@paperclip.invalid" }, message: "initial" });
    const stop = service.startWatcher({ listCompanyIds: async () => ["company-1"], debounceMs: 20, sweepMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(path.join(memory, "MEMORY.md"), "# Updated\n");
    await new Promise((resolve) => setTimeout(resolve, 90));
    stop();
    const repo = service.repoPathFor("company-1");
    const log = (await exec("git", ["--git-dir", repo, "log", "--format=%s"])).stdout;
    expect(log).toContain("claude-memory: capture external changes");
    const content = (await exec("git", ["--git-dir", repo, "show", "main:companies/company-1/agents/agent-1/memory/MEMORY.md"])).stdout;
    expect(content).toBe("# Updated\n");
    const bundle = path.join(homeDir, "memory.bundle");
    await service.exportBundle("company-1", bundle);
    await fs.rm(path.join(memory, "MEMORY.md"));
    await service.restore("company-1", bundle);
    expect(await fs.readFile(path.join(memory, "MEMORY.md"), "utf8")).toBe("# Updated\n");
  });
});

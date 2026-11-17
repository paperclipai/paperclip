import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountClaudeUserScopeSkills } from "./prompt-cache.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("mountClaudeUserScopeSkills", () => {
  it("links each selected skill into <configDir>/skills under its runtime name", async () => {
    const sourceRoot = await makeTempDir("paperclip-skill-src-");
    const configDir = await makeTempDir("paperclip-claude-config-");
    const source = path.join(sourceRoot, "guardrails");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: guardrails\ndescription: x\n---\nbody\n");

    const onLog = vi.fn(async () => {});
    await mountClaudeUserScopeSkills({
      configDir,
      skills: [{ key: "company/c/guardrails", runtimeName: "guardrails", source } as never],
      onLog,
    });

    const target = path.join(configDir, "skills", "guardrails");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain("name: guardrails");
    expect(onLog).not.toHaveBeenCalled();

    // Idempotent on a second run.
    await mountClaudeUserScopeSkills({
      configDir,
      skills: [{ key: "company/c/guardrails", runtimeName: "guardrails", source } as never],
      onLog,
    });
    expect(onLog).not.toHaveBeenCalled();
  });

  it("does nothing without a config dir or skills", async () => {
    const configDir = await makeTempDir("paperclip-claude-config-");
    const onLog = vi.fn(async () => {});
    await mountClaudeUserScopeSkills({ configDir: "", skills: [{} as never], onLog });
    await mountClaudeUserScopeSkills({ configDir, skills: [], onLog });
    await expect(fs.access(path.join(configDir, "skills"))).rejects.toThrow();
    expect(onLog).not.toHaveBeenCalled();
  });
});

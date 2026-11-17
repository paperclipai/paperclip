import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkClaudeSkillsIntoConfigDir } from "./prompt-cache.js";

const tempDirs: string[] = [];
async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("linkClaudeSkillsIntoConfigDir", () => {
  it("exposes enabled skills as user-scope skills in the managed config dir", async () => {
    const source = await tempDir("skill-src-");
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: guardrails\n---\nbody\n");
    const configDir = await tempDir("claude-config-");
    const onLog = vi.fn(async () => {});

    await linkClaudeSkillsIntoConfigDir({
      configDir,
      skills: [{ key: "company/x/guardrails", runtimeName: "guardrails", source } as never],
      onLog,
    });

    const linked = await fs.readFile(path.join(configDir, "skills", "guardrails", "SKILL.md"), "utf8");
    expect(linked).toContain("name: guardrails");
    expect(onLog).not.toHaveBeenCalled();
  });

  it("does nothing when no skills are enabled", async () => {
    const configDir = await tempDir("claude-config-");
    await linkClaudeSkillsIntoConfigDir({ configDir, skills: [], onLog: vi.fn(async () => {}) });
    await expect(fs.access(path.join(configDir, "skills"))).rejects.toThrow();
  });
});

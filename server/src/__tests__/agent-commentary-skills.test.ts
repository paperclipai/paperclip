import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexSkillsInjected, listCodexSkills } from "@paperclipai/adapter-codex-local/server";
import { listClaudeSkills } from "@paperclipai/adapter-claude-local/server";
import { readPaperclipRuntimeSkillEntries, resolveLegacyPaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import { prepareClaudePromptBundle } from "../../../packages/adapters/claude-local/src/server/prompt-cache.js";
import { stageCodexHomeForSync } from "../../../packages/adapters/codex-local/src/server/codex-home.js";

describe("default feedback skill delivery", () => {
  const cleanup: string[] = [];
  const keys = ["paperclip", "complain", "suggestion-box"].map(name => `paperclipai/paperclip/${name}`);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each([undefined, []])("resolves defaults for Codex and Claude with selection %s", async (desiredSkills) => {
    const config = desiredSkills ? { paperclipSkillSync: { desiredSkills } } : {};
    for (const [adapterType, list] of [["codex_local", listCodexSkills], ["claude_local", listClaudeSkills]] as const) {
      const snapshot = await list({ agentId: "agent", companyId: "company", adapterType, config });
      expect(snapshot.desiredSkills).toEqual(expect.arrayContaining(keys));
      expect(snapshot.entries.filter(e => keys.includes(e.key)).every(e => e.state === "configured")).toBe(true);
    }
  });

  it("mounts both skills and their shared helper for Codex, Claude and the Codex sandbox home", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-commentary-skills-"));
    cleanup.push(root);
    vi.stubEnv("PAPERCLIP_HOME", root);
    const entries = await readPaperclipRuntimeSkillEntries({}, import.meta.dirname, [fileURLToPath(new URL("../../../skills", import.meta.url))]);
    const desiredSkillNames = resolveLegacyPaperclipDesiredSkillNames({}, entries);
    const selected = entries.filter(e => desiredSkillNames.includes(e.key));
    const codexHome = join(root, "codex");
    await ensureCodexSkillsInjected(async () => {}, { skillsHome: join(codexHome, "skills"), skillsEntries: entries, desiredSkillNames });
    const claude = await prepareClaudePromptBundle({ companyId: "company", skills: selected, instructionsContents: null, onLog: async () => {} });
    const staged = await stageCodexHomeForSync(codexHome, { runId: "commentary-test" });
    cleanup.push(staged);
    for (const skills of [join(codexHome, "skills"), join(claude.addDir, ".claude", "skills"), join(staged, "skills")]) {
      for (const name of ["complain", "suggestion-box"]) {
        expect(await readFile(join(skills, name, "SKILL.md"), "utf8")).toContain("scripts/submit-agent-commentary.mjs");
      }
      expect(await readFile(join(skills, "paperclip", "scripts", "submit-agent-commentary.mjs"), "utf8")).toContain("process.stdin");
    }
    // Runtime policy removes entries before default selection; never resurrect them.
    const restricted = entries.filter(e => e.key === keys[0]);
    expect(resolveLegacyPaperclipDesiredSkillNames({}, restricted)).toEqual([keys[0]]);
    expect(await readPaperclipRuntimeSkillEntries({ paperclipRuntimeSkills: [] }, import.meta.dirname)).toEqual([]);
  });
});

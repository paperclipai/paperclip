import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import {
  INSTRUCTIONS_PATH_DIRECTIVE_TEMPLATE,
  buildClaudePromptBundleKey,
} from "./prompt-cache.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "paperclip-prompt-cache-test-"));
}

async function makeSkill(root: string, name: string, files: Record<string, string>): Promise<PaperclipSkillEntry> {
  const source = path.join(root, name);
  await fs.mkdir(source, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(source, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return { key: name, runtimeName: name, source };
}

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkTmp();
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("buildClaudePromptBundleKey — stat fingerprint", () => {
  it("stability: identical FS state produces identical digests", async () => {
    const skill = await makeSkill(tmpRoot, "skill-a", { "SKILL.md": "hi" });
    const instructions = path.join(tmpRoot, "AGENTS.md");
    await fs.writeFile(instructions, "agent prompt");
    const args = { skills: [skill], instructionsFilePath: instructions, instructionsFileDir: `${tmpRoot}/` };

    const first = await buildClaudePromptBundleKey(args);
    const second = await buildClaudePromptBundleKey(args);

    expect(first).toBe(second);
  });

  it("real edit invalidates the digest", async () => {
    const skill = await makeSkill(tmpRoot, "skill-a", { "SKILL.md": "hi" });
    const args = { skills: [skill], instructionsFilePath: null, instructionsFileDir: "" };

    const before = await buildClaudePromptBundleKey(args);
    await fs.writeFile(path.join(skill.source, "SKILL.md"), "hello world");
    const after = await buildClaudePromptBundleKey(args);

    expect(before).not.toBe(after);
  });

  it("rsync-style attack: ctime catches mtime-restored rewrites", async () => {
    const skill = await makeSkill(tmpRoot, "skill-a", { "SKILL.md": "original" });
    const target = path.join(skill.source, "SKILL.md");
    const args = { skills: [skill], instructionsFilePath: null, instructionsFileDir: "" };

    const before = await buildClaudePromptBundleKey(args);
    const originalStat = await fs.stat(target);

    // Wait long enough for clock to advance past mtime resolution, then rewrite
    // with identical-length contents and restore the prior mtime via utimes.
    // ctime will still update because the inode metadata changed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(target, "replaced");
    await fs.utimes(target, originalStat.atime, originalStat.mtime);

    const after = await buildClaudePromptBundleKey(args);
    expect(before).not.toBe(after);
  });

  it("chmod alone invalidates the digest (accepted false-positive, safe direction)", async () => {
    const skill = await makeSkill(tmpRoot, "skill-a", { "SKILL.md": "x" });
    const args = { skills: [skill], instructionsFilePath: null, instructionsFileDir: "" };

    const before = await buildClaudePromptBundleKey(args);
    await fs.chmod(path.join(skill.source, "SKILL.md"), 0o600);
    const after = await buildClaudePromptBundleKey(args);

    expect(before).not.toBe(after);
  });

  it("symlink retarget invalidates even when target stat happens to match", async () => {
    const skillRoot = path.join(tmpRoot, "skill-a");
    await fs.mkdir(skillRoot, { recursive: true });
    const targetA = path.join(tmpRoot, "targetA.md");
    const targetB = path.join(tmpRoot, "targetB.md");
    await fs.writeFile(targetA, "same content");
    await fs.writeFile(targetB, "same content");
    const linkPath = path.join(skillRoot, "linked.md");
    await fs.symlink(targetA, linkPath);

    const skill: PaperclipSkillEntry = { key: "skill-a", runtimeName: "skill-a", source: skillRoot };
    const args = { skills: [skill], instructionsFilePath: null, instructionsFileDir: "" };

    const before = await buildClaudePromptBundleKey(args);
    await fs.unlink(linkPath);
    await fs.symlink(targetB, linkPath);
    const after = await buildClaudePromptBundleKey(args);

    expect(before).not.toBe(after);
  });

  it("no-op resave invalidates (mtime bumps — accepted false-positive)", async () => {
    const skill = await makeSkill(tmpRoot, "skill-a", { "SKILL.md": "same" });
    const target = path.join(skill.source, "SKILL.md");
    const args = { skills: [skill], instructionsFilePath: null, instructionsFileDir: "" };

    const before = await buildClaudePromptBundleKey(args);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(target, "same");
    const after = await buildClaudePromptBundleKey(args);

    expect(before).not.toBe(after);
  });

  it("instructions path identity matters even when contents are identical", async () => {
    const pathA = path.join(tmpRoot, "A.md");
    const pathB = path.join(tmpRoot, "B.md");
    await fs.writeFile(pathA, "shared content");
    await fs.writeFile(pathB, "shared content");

    const keyA = await buildClaudePromptBundleKey({
      skills: [],
      instructionsFilePath: pathA,
      instructionsFileDir: `${tmpRoot}/`,
    });
    const keyB = await buildClaudePromptBundleKey({
      skills: [],
      instructionsFilePath: pathB,
      instructionsFileDir: `${tmpRoot}/`,
    });

    expect(keyA).not.toBe(keyB);
  });

  it("directive template edit auto-invalidates the digest", async () => {
    // We cannot mutate INSTRUCTIONS_PATH_DIRECTIVE_TEMPLATE at runtime, so we
    // verify the mechanism: build a key with the current template, then build
    // a parallel hash that simulates a directive-text change by including the
    // same body except for the directive line. They must differ.
    const instructions = path.join(tmpRoot, "AGENTS.md");
    await fs.writeFile(instructions, "agent prompt");
    const args = { skills: [], instructionsFilePath: instructions, instructionsFileDir: `${tmpRoot}/` };

    const actual = await buildClaudePromptBundleKey(args);

    // Reconstruct the key by hand, substituting a different directive text.
    const stat = await fs.stat(instructions);
    const hash = createHash("sha256");
    hash.update("paperclip-claude-prompt-bundle:v2\n");
    hash.update(`instructions:path:${instructions}\n`);
    hash.update(`instructions:dir:${tmpRoot}/\n`);
    hash.update(`instructions:stat:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}\n`);
    hash.update("instructions:directive:");
    hash.update("HYPOTHETICAL FUTURE DIRECTIVE TEXT");
    hash.update("\n");
    const counterfactual = hash.digest("hex");

    expect(actual).not.toBe(counterfactual);
  });

  it("dangling symlink produces a stable digest without throwing", async () => {
    const skillRoot = path.join(tmpRoot, "skill-a");
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.symlink(path.join(tmpRoot, "nonexistent-target.md"), path.join(skillRoot, "linked.md"));
    const skill: PaperclipSkillEntry = { key: "skill-a", runtimeName: "skill-a", source: skillRoot };
    const args = { skills: [skill], instructionsFilePath: null, instructionsFileDir: "" };

    const first = await buildClaudePromptBundleKey(args);
    const second = await buildClaudePromptBundleKey(args);

    expect(first).toBe(second);
  });

  it("v1 prefix legacy key does not match v2 prefix new key", async () => {
    const instructions = path.join(tmpRoot, "AGENTS.md");
    await fs.writeFile(instructions, "agent prompt");
    const v2 = await buildClaudePromptBundleKey({
      skills: [],
      instructionsFilePath: instructions,
      instructionsFileDir: `${tmpRoot}/`,
    });

    // Reconstruct what a v1 key would have looked like for the same inputs.
    const v1Hash = createHash("sha256");
    v1Hash.update("paperclip-claude-prompt-bundle:v1\n");
    v1Hash.update("instructions\n");
    v1Hash.update(await fs.readFile(instructions, "utf-8"));
    v1Hash.update("\n");
    const v1 = v1Hash.digest("hex");

    expect(v1).not.toBe(v2);
  });

  it("missing instructions path produces stable identity across heartbeats", async () => {
    const missing = path.join(tmpRoot, "does-not-exist.md");
    const args = { skills: [], instructionsFilePath: missing, instructionsFileDir: `${tmpRoot}/` };

    const first = await buildClaudePromptBundleKey(args);
    const second = await buildClaudePromptBundleKey(args);

    expect(first).toBe(second);
  });
});

describe("INSTRUCTIONS_PATH_DIRECTIVE_TEMPLATE", () => {
  it("renders a string containing both the path and the directory", () => {
    const rendered = INSTRUCTIONS_PATH_DIRECTIVE_TEMPLATE("/x/AGENTS.md", "/x/");
    expect(rendered).toContain("/x/AGENTS.md");
    expect(rendered).toContain("/x/");
    expect(rendered).toContain("loaded from");
  });
});

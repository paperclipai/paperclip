import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCopilotPromptBundleKey } from "../adapters/copilot-local/prompt-bundle.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("copilot prompt bundle key", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("changes when instructions change", async () => {
    const root = await makeTempDir("paperclip-copilot-bundle-");
    cleanupDirs.add(root);
    const skillDir = path.join(root, "paperclip");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: paperclip\n---\n", "utf8");

    const baseInput = {
      skills: [{
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: skillDir,
        required: true,
        requiredReason: "required",
      }],
      instructionsContents: "alpha",
    };

    const first = await buildCopilotPromptBundleKey(baseInput);
    const second = await buildCopilotPromptBundleKey({ ...baseInput, instructionsContents: "beta" });
    expect(first).not.toBe(second);
  });

  it("changes when skill contents change", async () => {
    const root = await makeTempDir("paperclip-copilot-bundle-");
    cleanupDirs.add(root);
    const skillDir = path.join(root, "paperclip");
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, "---\nname: paperclip\n---\n", "utf8");

    const baseInput = {
      skills: [{
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: skillDir,
        required: true,
        requiredReason: "required",
      }],
      instructionsContents: "alpha",
    };

    const first = await buildCopilotPromptBundleKey(baseInput);
    await fs.writeFile(skillFile, "---\nname: paperclip\nversion: 2\n---\n", "utf8");
    const second = await buildCopilotPromptBundleKey(baseInput);
    expect(first).not.toBe(second);
  });
});

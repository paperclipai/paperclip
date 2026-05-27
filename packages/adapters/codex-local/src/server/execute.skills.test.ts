import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexSkillsInjected } from "./execute.js";

describe("codex skill injection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to copying skill directories when Windows blocks links", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-skills-"));
    const source = path.join(root, "source", "paperclip-test");
    const skillsHome = path.join(root, "codex-home", "skills");
    const target = path.join(skillsHome, "paperclip-test");

    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Test skill\n", "utf8");

    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "symlink").mockImplementationOnce(async () => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      await ensureCodexSkillsInjected(async () => {}, {
        skillsHome,
        skillsEntries: [
          {
            key: "paperclipai/paperclip/paperclip-test",
            runtimeName: "paperclip-test",
            source,
          },
        ],
        desiredSkillNames: ["paperclipai/paperclip/paperclip-test"],
      });

      expect((await fs.lstat(target)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# Test skill\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

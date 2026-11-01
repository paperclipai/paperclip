import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePaperclipSkillSymlink, linkSkillDirectory } from "./server-utils.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { ...platform, value });
const eperm = () => Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

describe("linkSkillDirectory", () => {
  it("falls back to a directory junction on Windows when symlinks are not permitted", async () => {
    setPlatform("win32");
    const symlink = vi.spyOn(fs, "symlink").mockRejectedValueOnce(eperm()).mockResolvedValueOnce(undefined);
    await linkSkillDirectory("C:\\skills\\paperclip", "C:\\home\\skills\\paperclip");
    expect(symlink).toHaveBeenCalledTimes(2);
    expect(symlink.mock.calls[0]).toEqual(["C:\\skills\\paperclip", "C:\\home\\skills\\paperclip"]);
    expect(symlink.mock.calls[1]).toEqual(["C:\\skills\\paperclip", "C:\\home\\skills\\paperclip", "junction"]);
  });

  it("does not hide the error on other platforms or other error codes", async () => {
    setPlatform("linux");
    vi.spyOn(fs, "symlink").mockRejectedValue(eperm());
    await expect(linkSkillDirectory("/a", "/b")).rejects.toMatchObject({ code: "EPERM" });
    setPlatform("win32");
    vi.restoreAllMocks();
    vi.spyOn(fs, "symlink").mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(linkSkillDirectory("C:\\a", "C:\\b")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("ensurePaperclipSkillSymlink with the default linker", () => {
  it("creates a readable link and then reports it as already correct", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-skill-link-"));
    try {
      const source = path.join(dir, "source");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n");
      const target = path.join(dir, "installed");
      expect(await ensurePaperclipSkillSymlink(source, target)).toBe("created");
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toContain("# skill");
      const linked = await fs.readlink(target);
      expect(path.resolve(path.dirname(target), linked)).toBe(path.resolve(source));
      expect(await ensurePaperclipSkillSymlink(source, target)).toBe("skipped");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

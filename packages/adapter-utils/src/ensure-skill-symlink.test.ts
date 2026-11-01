import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePaperclipSkillSymlink, linkSkillDirectory } from "./server-utils.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(value: string) { Object.defineProperty(process, "platform", { ...platform, value }); }
const failure = (code: string) => Object.assign(new Error(code), { code });
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); });

describe("skill directory junction fallback", () => {
  it.each(["EPERM", "EACCES"])("uses a junction after %s on Windows", async (code) => {
    setPlatform("win32");
    const source = path.resolve("source"), target = path.resolve("installed");
    const link = vi.spyOn(fs, "symlink").mockRejectedValueOnce(failure(code)).mockResolvedValueOnce(undefined);
    await linkSkillDirectory(source, target);
    expect(link.mock.calls).toEqual([[source, target], [source, target, "junction"]]);
  });
  it("preserves relative source semantics when the working directory differs", async () => {
    setPlatform("win32");
    const target = path.resolve("nested", "skills", "installed");
    const link = vi.spyOn(fs, "symlink").mockRejectedValueOnce(failure("EPERM")).mockResolvedValueOnce(undefined);
    await linkSkillDirectory("../source", target);
    expect(link.mock.calls[1]).toEqual([path.resolve(path.dirname(target), "../source"), target, "junction"]);
  });
  it.each([["linux", "EPERM"], ["darwin", "EACCES"], ["win32", "ENOENT"], ["win32", "EEXIST"]])("preserves %s/%s errors", async (system, code) => {
    setPlatform(system);
    const error = failure(code), link = vi.spyOn(fs, "symlink").mockRejectedValue(error);
    await expect(linkSkillDirectory("source", "target")).rejects.toBe(error);
    expect(link).toHaveBeenCalledTimes(1);
  });
  it("does not retry a successful symlink", async () => {
    const link = vi.spyOn(fs, "symlink").mockResolvedValue(undefined);
    await linkSkillDirectory("source", "target");
    expect(link.mock.calls).toEqual([["source", "target"]]);
  });
  it("preserves junction errors", async () => {
    setPlatform("win32");
    const error = failure("EACCES");
    const link = vi.spyOn(fs, "symlink").mockRejectedValueOnce(failure("EPERM")).mockRejectedValueOnce(error);
    await expect(linkSkillDirectory("source", "target")).rejects.toBe(error);
    expect(link).toHaveBeenCalledTimes(2);
  });
  it("preserves injected linkers", async () => {
    vi.spyOn(fs, "lstat").mockRejectedValue(failure("ENOENT"));
    const link = vi.fn().mockResolvedValue(undefined), symlink = vi.spyOn(fs, "symlink");
    expect(await ensurePaperclipSkillSymlink("source", "target", link)).toBe("created");
    expect(link).toHaveBeenCalledWith("source", "target");
    expect(symlink).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === "win32")("creates, reads and repairs real NTFS junctions without removing the source", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-junction-"));
    try {
      const source = path.join(dir, "source"), bundle = path.join(dir, "bundle"), target = path.join(bundle, "skill");
      await fs.mkdir(source); await fs.mkdir(bundle);
      await fs.writeFile(path.join(source, "SKILL.md"), "# fixture\n");
      const realSymlink = fs.symlink.bind(fs);
      const link = vi.spyOn(fs, "symlink").mockImplementation(async (from, to, type) => {
        if (type !== "junction") throw failure("EPERM");
        return realSymlink(from, to, type);
      });
      expect(await ensurePaperclipSkillSymlink(source, target)).toBe("created");
      expect(link).toHaveBeenLastCalledWith(source, target, "junction");
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# fixture\n");
      expect(path.resolve(await fs.readlink(target))).toBe(source);
      expect(await ensurePaperclipSkillSymlink(source, target)).toBe("skipped");
      await fs.unlink(target);
      await realSymlink(path.join(dir, "missing"), target, "junction");
      expect(await ensurePaperclipSkillSymlink(source, target)).toBe("repaired");
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# fixture\n");
      await fs.unlink(target);
      await linkSkillDirectory("../source", target);
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# fixture\n");
      if (!path.resolve(bundle).startsWith(path.resolve(dir) + path.sep)) throw Error("Unsafe cleanup");
      await fs.rm(bundle, { recursive: true });
      expect(await fs.readFile(path.join(source, "SKILL.md"), "utf8")).toBe("# fixture\n");
    } finally {
      if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + "pc-junction-")) throw Error("Unsafe cleanup");
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

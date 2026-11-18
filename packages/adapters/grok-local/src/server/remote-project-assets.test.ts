import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareGrokRemoteProjectAssets } from "./remote-project-assets.js";

it.each(["existing", "new", "unsafe", "changed"])("keeps %s project files safe while staging Grok runtime assets", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-project-assets-"));
  try {
    const cwd = path.join(root, "workspace"), assets = path.join(root, "assets"), outside = path.join(root, "outside");
    await fs.mkdir(cwd); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    const stagedSkill = path.join(assets, ".claude/skills/selected");
    await fs.mkdir(stagedSkill, { recursive: true });
    await fs.writeFile(path.join(stagedSkill, "SKILL.md"), "selected skill");
    await fs.writeFile(path.join(assets, "Agents.md"), "agent instructions");
    if (scenario === "existing") {
      await fs.mkdir(path.join(cwd, ".claude/skills/own"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".claude/skills/own/keep.txt"), "user skill");
    }
    if (scenario === "unsafe") await fs.symlink(outside, path.join(cwd, ".claude"));
    const input = { runId: "fixture", target: { kind: "local" as const }, cwd, assets };
    if (scenario === "unsafe") {
      await expect(prepareGrokRemoteProjectAssets(input)).rejects.toThrow("Could not prepare Grok SSH runtime assets");
      expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
      return;
    }
    const prepared = await prepareGrokRemoteProjectAssets(input);
    expect(prepared.rulesFilePath).toBe(path.join(assets, "Agents.md"));
    expect(await fs.readFile(path.join(cwd, ".claude/skills/selected/SKILL.md"), "utf8")).toBe("selected skill");
    if (scenario === "changed") {
      await fs.rename(path.join(cwd, ".claude"), path.join(cwd, ".claude-original"));
      await fs.symlink(outside, path.join(cwd, ".claude"));
      await expect(prepared.cleanup()).rejects.toThrow("Could not prepare Grok SSH runtime assets");
      expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
    } else {
      await fs.writeFile(path.join(cwd, ".claude/user.txt"), "user work");
      await prepared.cleanup();
      expect(await fs.readFile(path.join(cwd, ".claude/user.txt"), "utf8")).toBe("user work");
      await expect(fs.stat(path.join(cwd, ".claude/skills/selected"))).rejects.toMatchObject({ code: "ENOENT" });
      if (scenario === "existing") expect(await fs.readFile(path.join(cwd, ".claude/skills/own/keep.txt"), "utf8")).toBe("user skill");
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("uses the configured remote PATH for its Node staging command", async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"grok-project-path-"));
  try {
    const cwd=path.join(root,"workspace"),assets=path.join(root,"assets"),bin=path.join(root,"bin"),marker=path.join(root,"node-used");
    await fs.mkdir(cwd);await fs.mkdir(assets);await fs.mkdir(bin);
    await fs.writeFile(path.join(bin,"node"),"#!/bin/sh\nprintf used > "+JSON.stringify(marker)+"\nexec "+JSON.stringify(process.execPath)+" \"$@\"\n",{mode:0o700});
    const prepared=await prepareGrokRemoteProjectAssets({runId:"fixture",target:{kind:"local"},cwd,assets,env:{PATH:bin+path.delimiter+process.env.PATH}});
    expect(await fs.readFile(marker,"utf8")).toBe("used");await prepared.cleanup();
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

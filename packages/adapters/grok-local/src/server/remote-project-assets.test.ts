import { startSshEnvLabFixture, stopSshEnvLabFixture, buildSshEnvLabFixtureConfig, getSshEnvLabSupport, shellQuote } from "@paperclipai/adapter-utils/ssh";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareGrokRemoteProjectAssets } from "./remote-project-assets.js";

it.each(["existing", "new", "unsafe", "changed", "linked"])("keeps %s project files safe while staging Grok runtime assets", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-project-assets-"));
  try {
    const cwd = path.join(root, "workspace"), assets = path.join(root, "assets"), outside = path.join(root, "outside");
    await fs.mkdir(cwd); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "outside");
    const stagedSkill = path.join(assets, ".claude/skills/selected");
    await fs.mkdir(stagedSkill, { recursive: true });
    await fs.writeFile(path.join(stagedSkill, "SKILL.md"), "selected skill");
    await fs.writeFile(path.join(assets, "Agents.md"), "agent instructions");
    if (scenario === 'linked') {const actual=path.join(root,'selected-source');await fs.rename(stagedSkill,actual);await fs.symlink(actual,stagedSkill);}
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
    await fs.writeFile(path.join(bin,"node"),"#!/bin/sh\nprintf used > "+shellQuote(marker)+"\nexec "+shellQuote(process.execPath)+" \"$@\"\n",{mode:0o700});
    const prepared=await prepareGrokRemoteProjectAssets({runId:"fixture",target:{kind:"local"},cwd,assets,env:{PATH:bin+path.delimiter+process.env.PATH}});
    expect(await fs.readFile(marker,"utf8")).toBe("used");await prepared.cleanup();
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

it.skipIf(!(await getSshEnvLabSupport()).supported)('stages assets through an actual SSH target',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'grok-assets-ssh-'));let state;
 try{state=await startSshEnvLabFixture({statePath:path.join(root,'state.json')});const spec=await buildSshEnvLabFixtureConfig(state);const cwd=spec.remoteWorkspacePath,assets=path.join(root,'assets');await fs.mkdir(path.join(assets,'.claude','skills','selected'),{recursive:true});await fs.writeFile(path.join(assets,'.claude','skills','selected','SKILL.md'),'selected');const result=await prepareGrokRemoteProjectAssets({runId:'fixture',target:{kind:'remote',transport:'ssh',environmentId:'test',leaseId:'test',remoteCwd:cwd,spec:{...spec,remoteCwd:cwd}},cwd,assets,env:{PATH:[path.dirname(process.execPath),'/usr/bin','/bin'].join(':')}});expect(await fs.readFile(path.join(cwd,'.claude','skills','selected','SKILL.md'),'utf8')).toBe('selected');await result.cleanup();}
 finally{if(state)await stopSshEnvLabFixture(state);await fs.rm(root,{recursive:true,force:true});}
},30000);

it("copies a skill's nested files into the folder it creates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-project-assets-"));
  try {
    const cwd = path.join(root, "workspace"), assets = path.join(root, "assets");
    const stagedSkill = path.join(assets, ".claude/skills/nested");
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(stagedSkill, "references/deep"), { recursive: true });
    await fs.writeFile(path.join(stagedSkill, "SKILL.md"), "nested skill");
    await fs.writeFile(path.join(stagedSkill, "references/deep/notes.md"), "deep notes");
    const prepared = await prepareGrokRemoteProjectAssets({ runId: "fixture", target: { kind: "local" as const }, cwd, assets });
    const copied = path.join(cwd, ".claude/skills/nested");
    expect(await fs.readFile(path.join(copied, "SKILL.md"), "utf8")).toBe("nested skill");
    expect(await fs.readFile(path.join(copied, "references/deep/notes.md"), "utf8")).toBe("deep notes");
    await prepared.cleanup();
    await expect(fs.stat(path.join(cwd, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCanonicalWorktreeSeedSource } from "./worktree-seed-source.js";

const cleanup: string[] = [];

function makeInstance(prefix: string, instanceId: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(cwd);
  const configDir = path.join(cwd, ".paperclip");
  const configPath = path.join(configDir, "config.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n");
  fs.writeFileSync(path.join(configDir, ".env"), `PAPERCLIP_INSTANCE_ID=${instanceId}\n`);
  return { cwd, configPath, instanceId };
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveCanonicalWorktreeSeedSource", () => {
  it("returns only the registered base workspace config", () => {
    const source = makeInstance("paperclip-seed-source-", "source-instance");
    const target = makeInstance("paperclip-seed-target-", "target-instance");

    expect(resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: source.cwd,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: source.configPath, instanceId: source.instanceId },
      manifestTargetInstanceId: target.instanceId,
    })).toMatchObject({
      baseWorkspaceCwd: source.cwd,
      configPath: source.configPath,
      targetConfigPath: target.configPath,
    });
  });

  it("fails closed without registration and when source equals target", () => {
    const target = makeInstance("paperclip-seed-same-target-", "target-instance");
    const diagnostic = { configPath: target.configPath, instanceId: target.instanceId };

    expect(() => resolveCanonicalWorktreeSeedSource({
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: diagnostic,
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/not registered/);

    expect(() => resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: target.cwd,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: diagnostic,
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/same canonical file/);
  });
});

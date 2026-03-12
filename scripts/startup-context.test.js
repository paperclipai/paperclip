import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStartupContext, writeStartupProfile } from "./startup-context.mjs";

const tempRoots = [];

async function createRepoRoot(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-${name}-`));
  tempRoots.push(root);
  return root;
}

async function touchConfig(configPath) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "{}\n");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveStartupContext", () => {
  it("prefers explicit environment overrides over the repo-local profile", async () => {
    const repoRoot = await createRepoRoot("startup-explicit");
    const profileConfig = path.join(repoRoot, "profile-home", "instances", "default", "config.json");
    await touchConfig(profileConfig);
    await writeStartupProfile(repoRoot, {
      paperclipHome: path.join(repoRoot, "profile-home"),
      instanceId: "default",
      configPath: profileConfig,
    });

    const envConfig = path.join(repoRoot, "env-home", "instances", "runtime", "config.json");
    await touchConfig(envConfig);

    const context = await resolveStartupContext({
      repoRoot,
      modeLabel: "start",
      env: {
        PAPERCLIP_HOME: path.join(repoRoot, "env-home"),
        PAPERCLIP_INSTANCE_ID: "runtime",
        PAPERCLIP_CONFIG: envConfig,
      },
    });

    expect(context.source).toBe("env");
    expect(context.paperclipHome).toBe(path.join(repoRoot, "env-home"));
    expect(context.instanceId).toBe("runtime");
    expect(context.configPath).toBe(envConfig);
  });

  it("reuses the saved repo-local startup profile when env overrides are absent", async () => {
    const repoRoot = await createRepoRoot("startup-profile");
    const configPath = path.join(repoRoot, "runtime-home", "instances", "default", "config.json");
    await touchConfig(configPath);
    await writeStartupProfile(repoRoot, {
      paperclipHome: path.join(repoRoot, "runtime-home"),
      instanceId: "default",
      configPath,
    });

    const context = await resolveStartupContext({
      repoRoot,
      modeLabel: "start",
      env: {},
    });

    expect(context.source).toBe("repo_profile");
    expect(context.configPath).toBe(configPath);
  });

  it("fails fast in non-interactive mode when no startup context is pinned", async () => {
    const repoRoot = await createRepoRoot("startup-ambiguous");

    await expect(
      resolveStartupContext({
        repoRoot,
        modeLabel: "start",
        env: {},
      }),
    ).rejects.toThrow("Startup context is ambiguous");
  });
});

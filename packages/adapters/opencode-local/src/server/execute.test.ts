import { mkdtemp, readdir, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildOpenCodeSkillsDir, ensureRemoteOpenCodeModelConfiguredAndAvailable } from "./execute.js";

describe("buildOpenCodeSkillsDir create-agent inclusion", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeConfigWithSkills() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-skilltest-"));
    cleanupDirs.push(root);
    const createAgentSource = path.join(root, "paperclip-create-agent");
    const otherSource = path.join(root, "paperclip");
    await mkdir(createAgentSource, { recursive: true });
    await mkdir(otherSource, { recursive: true });
    // Runtime skills are configured directly on the adapter config so the helper
    // resolves them without touching the packaged skills directory.
    return {
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/paperclip-create-agent",
          runtimeName: "paperclip-create-agent",
          source: createAgentSource,
        },
        {
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source: otherSource,
        },
      ],
    } as Record<string, unknown>;
  }

  it("includes the paperclip-create-agent skill when the agent can hire", async () => {
    const config = await makeConfigWithSkills();
    const dir = await buildOpenCodeSkillsDir(config, { canCreateAgents: true });
    cleanupDirs.push(path.dirname(dir));
    const entries = await readdir(dir);
    expect(entries).toContain("paperclip-create-agent");
  });

  it("excludes the paperclip-create-agent skill when the agent cannot hire", async () => {
    const config = await makeConfigWithSkills();
    const dir = await buildOpenCodeSkillsDir(config, { canCreateAgents: false });
    cleanupDirs.push(path.dirname(dir));
    const entries = await readdir(dir);
    expect(entries).not.toContain("paperclip-create-agent");
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

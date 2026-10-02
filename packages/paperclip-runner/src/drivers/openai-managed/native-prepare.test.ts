import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "../../live/runnerd-codex-transport.js";

it.each(["none", "openai_hosted"] as const)("prepares and closes %s through the real runner without starting inference", async (type) => {
  const directory = await realpath(await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "po-native-")));
  const bundle = createCapabilityRunnerdCodexTransport({
    provider: "openai_managed",
    stateDirectory: directory,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    environment: { PATH: process.env.PATH, OPENAI_API_KEY: "offline-prepare-canary" },
    openaiProfile: {
      profileId: "offline-prepare", model: "gpt-6-astra", apiRevision: "agents=v1",
      reasoningEffort: "medium", maxEstimatedSessionCostUsd: 2, timeoutSeconds: 180,
      environment: type === "none" ? { type } : { type, container_size: "medium", network: { access: "disabled" } },
    },
  });
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: directory, model: "gpt-6-astra", dynamicTools: [] });
    expect(opened).toMatchObject({ thread: {
      id: expect.stringMatching(/^pending_[a-f0-9]{64}$/),
      sessionId: expect.stringMatching(/^pending_[a-f0-9]{64}$/),
      model: "gpt-6-astra", modelProvider: "openai",
    } });
    expect(bundle.evidence()).toMatchObject({
      providerDriver: "openai_agents_api", providerService: "openai_agents_api",
      providerExecutionKind: "remote_service", providerPid: null, codexPid: null,
      childEnvironmentKeys: ["OPENAI_API_KEY", "PATH"],
    });
    expect(await bundle.transport.request("thread/read", {})).toMatchObject({ thread: { turns: [] } });
  } finally {
    await bundle.transport.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

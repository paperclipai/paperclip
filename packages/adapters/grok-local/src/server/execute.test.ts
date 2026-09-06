import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// Bundles the remote-lane mock state and every mocked execution-target
// function behind one hoisted object, so the `vi.mock` factory below (which
// runs before the top-level `import`s) can close over it. `state.isRemote`
// lets a test force the remote lane on; `state.prepareRuntimeResult` lets a
// test override what `prepareAdapterExecutionTargetRuntime` hands back
// (`workspaceRemoteDir` / `assetDirs`) without a fresh `vi.mock` per case.
const mocks = vi.hoisted(() => {
  const state: {
    isRemote: boolean;
    prepareRuntimeResult: { workspaceRemoteDir?: string | null; assetDirs?: Record<string, string> } | null;
  } = { isRemote: false, prepareRuntimeResult: null };
  return {
    state,
    ensureRuntimeInstalledMock: vi.fn(async () => {}),
    ensureCommandMock: vi.fn(async () => {}),
    resolveCommandForLogsMock: vi.fn(async () => "grok"),
    runProcessMock: vi.fn(),
    prepareRuntimeMock: vi.fn(
      async (input: { assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean }> }) => {
        const override = state.prepareRuntimeResult;
        const assetDirs =
          override?.assetDirs ??
          Object.fromEntries(
            (input.assets ?? []).map((asset) => [asset.key, `/remote/workspace/.paperclip-runtime/grok/${asset.key}`]),
          );
        const workspaceRemoteDir = override && "workspaceRemoteDir" in override
          ? override.workspaceRemoteDir
          : "/remote/workspace";
        return { workspaceRemoteDir, assetDirs, restoreWorkspace: async () => {} };
      },
    ),
  };
});

const {
  state: remoteState,
  ensureRuntimeInstalledMock,
  ensureCommandMock,
  resolveCommandForLogsMock,
  runProcessMock,
  prepareRuntimeMock,
} = mocks;

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => mocks.state.isRemote,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) =>
    mocks.state.isRemote ? "/remote/workspace" : cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: mocks.state.isRemote ? "remote" : "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => (mocks.state.isRemote ? "remote" : "local"),
  ensureAdapterExecutionTargetCommandResolvable: (...args: unknown[]) =>
    (mocks.ensureCommandMock as (...args: unknown[]) => unknown)(...args),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: (...args: unknown[]) =>
    (mocks.ensureRuntimeInstalledMock as (...args: unknown[]) => unknown)(...args),
  prepareAdapterExecutionTargetRuntime: (...args: unknown[]) =>
    (mocks.prepareRuntimeMock as (...args: unknown[]) => unknown)(...args),
  readAdapterExecutionTarget: () =>
    mocks.state.isRemote ? { kind: "remote", transport: "ssh" } : { kind: "local" },
  resolveAdapterExecutionTargetCommandForLogs: (...args: unknown[]) =>
    (mocks.resolveCommandForLogsMock as (...args: unknown[]) => unknown)(...args),
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: (...args: unknown[]) =>
    (mocks.runProcessMock as (...args: unknown[]) => unknown)(...args),
}));

import { execute } from "./execute.js";
import { resolveManagedGrokHomeDir } from "./grok-home.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-grok-local-"));
  tempRoots.push(root);
  return root;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

const GROK_IDENTITY = "https://auth.x.ai::11111111-1111-1111-1111-111111111111";
const NOW = Date.now();
const NEWER_EXPIRY = new Date(NOW + 2 * 60_000).toISOString();
const OLDER_EXPIRY = new Date(NOW + 60_000).toISOString();

function grokAuth(input: { key: string; expiresAt: string }): string {
  return JSON.stringify({
    [GROK_IDENTITY]: { key: input.key, refresh_token: `${input.key}-refresh`, expires_at: input.expiresAt },
  });
}

// Captures the sandbox `auth.json` bytes a mocked remote teardown hands back
// to the `home` asset's `restore` contribution — mirrors the sandbox core's
// own restore closure without needing a live sandbox. `error`, when set, makes
// the injected `readFile` reject instead of resolving.
const sandboxAuthFixture: { bytes: Buffer | null; error: (Error & { code?: string }) | null } = {
  bytes: null,
  error: null,
};

function makeRestoreWorkspace(
  assets: Array<{ restore?: (ctx: { assetDir: string; readFile: (path: string) => Promise<Buffer> }) => Promise<void> }>,
) {
  return async () => {
    for (const asset of assets) {
      if (!asset.restore) continue;
      await asset.restore({
        assetDir: "/remote/workspace/.paperclip-runtime/grok/home",
        readFile: async () => {
          if (sandboxAuthFixture.error) throw sandboxAuthFixture.error;
          if (sandboxAuthFixture.bytes === null) {
            throw Object.assign(new Error("ENOENT: no such file or directory, open 'auth.json'"), { code: "ENOENT" });
          }
          return sandboxAuthFixture.bytes;
        },
      });
    }
  };
}

function makeSuccessfulRunResult(overrides: Partial<{ sessionId: string }> = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: overrides.sessionId ?? "sess-1",
      requestId: "req-1",
    }),
    stderr: "",
  };
}

async function makeCtx(runId: string, cwd: string): Promise<AdapterExecutionContext> {
  return {
    runId,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Grok Agent",
      adapterType: "grok_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
  };
}

describe("grok_local execute", () => {
  beforeEach(() => {
    mocks.state.isRemote = false;
    mocks.state.prepareRuntimeResult = null;
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("stages Grok-native instructions and skills into the workspace for the run and cleans them up afterward", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");

    runProcessMock.mockImplementation(async (_runId, _target, _command, args, options) => {
      expect(args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "streaming-json",
          "--always-approve",
        ]),
      );
      // Grok >= 1.0 enforces `dontAsk` as deny-by-default over --always-approve,
      // so no permission mode may be passed unless explicitly configured.
      expect(args).not.toContain("--permission-mode");
      expect(await fs.readFile(path.join(root, "Agents.md"), "utf8")).toContain("You are Grok.");
      expect(await pathExists(path.join(root, ".claude", "skills", "paperclip", "SKILL.md"))).toBe(true);
      await options.onLog?.("stdout", '{"type":"text","data":"done"}\n');
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "sess-1",
      sessionDisplayId: "sess-1",
    });
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
    expect(logs.map((entry) => entry.chunk)).not.toEqual([]);
  });

  it("reports real per-run token usage, marks it as per_run, and only surfaces cost for API billing", async () => {
    runProcessMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", data: "done" }),
        JSON.stringify({
          type: "end",
          stopReason: "EndTurn",
          sessionId: "sess-1",
          requestId: "req-1",
          usage: { input_tokens: 2384, output_tokens: 261, cache_read_input_tokens: 23040 },
          total_cost_usd: 0.013246,
        }),
      ].join("\n"),
      stderr: "",
    }));

    const previousApiKey = process.env.XAI_API_KEY;
    try {
      // Subscription billing (no XAI_API_KEY): token usage is populated, but
      // there is no marginal dollar cost so costUsd stays null. Clear the key
      // explicitly so the ambient environment (dev machine or CI with provider
      // secrets) cannot flip this branch to API billing.
      delete process.env.XAI_API_KEY;
      const subscriptionResult = await execute(await makeCtx("run-subscription", await makeTempRoot()));
      expect(subscriptionResult).toMatchObject({
        usage: { inputTokens: 2384, outputTokens: 261, cachedInputTokens: 23040 },
        usageBasis: "per_run",
        billingType: "subscription",
        costUsd: null,
      });

      // API-key billing: same token usage, plus the real dollar cost.
      process.env.XAI_API_KEY = "test-key";
      const apiResult = await execute(await makeCtx("run-api", await makeTempRoot()));
      expect(apiResult).toMatchObject({
        usage: { inputTokens: 2384, outputTokens: 261, cachedInputTokens: 23040 },
        usageBasis: "per_run",
        billingType: "api",
        costUsd: 0.013246,
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
    }
  });

  it("sets GROK_HOME to the company home in subscription mode, and leaves it unset when XAI_API_KEY exists", async () => {
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return makeSuccessfulRunResult();
    });

    const previousApiKey = process.env.XAI_API_KEY;
    try {
      delete process.env.XAI_API_KEY;
      await execute(await makeCtx("run-subscription-home", await makeTempRoot()));
      expect(seenEnv.GROK_HOME).toBe(resolveManagedGrokHomeDir(process.env, "company-1"));

      // The XAI_API_KEY path stays unchanged: no GROK_HOME is set when the key
      // exists, because the CLI authenticates via the environment variable
      // directly, not from the company Grok home's auth.json.
      process.env.XAI_API_KEY = "test-key";
      await execute(await makeCtx("run-api-home", await makeTempRoot()));
      expect(seenEnv.GROK_HOME).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
    }
  });

  it("passes an explicitly configured permissionMode through to the CLI", async () => {
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return makeSuccessfulRunResult();
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-permission-mode",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: await makeTempRoot(), permissionMode: "bypassPermissions" },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await execute(ctx);

    const flagIndex = seenArgs.indexOf("--permission-mode");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(seenArgs[flagIndex + 1]).toBe("bypassPermissions");
  });

  it("cleans up staged assets when setup fails before the Grok process starts", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");
    ensureCommandMock.mockRejectedValueOnce(new Error("grok not installed"));

    const ctx: AdapterExecutionContext = {
      runId: "run-setup-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await expect(execute(ctx)).rejects.toThrow("grok not installed");
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
  });

  describe("remote lane credential staging", () => {
    let previousApiKey: string | undefined;
    let previousPaperclipHome: string | undefined;
    let paperclipHomeRoot: string;

    beforeEach(async () => {
      previousApiKey = process.env.XAI_API_KEY;
      previousPaperclipHome = process.env.PAPERCLIP_HOME;
      // Point the managed Grok home at a private tmp root, so staging never
      // touches a real developer or CI-host `~/.paperclip` tree.
      paperclipHomeRoot = await makeTempRoot();
      process.env.PAPERCLIP_HOME = paperclipHomeRoot;
      sandboxAuthFixture.bytes = null;
      sandboxAuthFixture.error = null;
    });

    afterEach(() => {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    });

    async function seedHostGrokAuth(contents: string): Promise<string> {
      const hostGrokHome = resolveManagedGrokHomeDir(process.env, "company-1");
      await fs.mkdir(hostGrokHome, { recursive: true });
      await fs.writeFile(path.join(hostGrokHome, "auth.json"), contents, "utf8");
      return hostGrokHome;
    }

    it("passes one home asset that carries the staged directory in a remote subscription run", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      await seedHostGrokAuth(JSON.stringify({ live: "token" }));
      runProcessMock.mockImplementation(async () => makeSuccessfulRunResult());

      // Read the staged asset while `prepareAdapterExecutionTargetRuntime` still
      // holds it — the run's `finally` removes the staged dir once `execute()`
      // returns, so any read after that point sees it already gone.
      let stagedAuthContents = "";
      let homeAssetShape: { key: string; followSymlinks?: boolean; provision?: unknown; restore?: unknown } | null = null;
      let assetCount = -1;
      prepareRuntimeMock.mockImplementationOnce(
        async (input: { assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean; provision?: unknown; restore?: unknown }> }) => {
          const assets = input.assets ?? [];
          assetCount = assets.length;
          const [homeAsset] = assets;
          homeAssetShape = homeAsset
            ? { key: homeAsset.key, followSymlinks: homeAsset.followSymlinks, provision: homeAsset.provision, restore: homeAsset.restore }
            : null;
          if (homeAsset) {
            stagedAuthContents = await fs.readFile(path.join(homeAsset.localDir, "auth.json"), "utf8");
          }
          return {
            workspaceRemoteDir: "/remote/workspace",
            assetDirs: { home: "/remote/workspace/.paperclip-runtime/grok/home" },
            restoreWorkspace: async () => {},
          };
        },
      );

      await execute(await makeCtx("run-remote-subscription-asset", await makeTempRoot()));

      expect(assetCount).toBe(1);
      expect(homeAssetShape).toMatchObject({ key: "home", followSymlinks: true });
      expect((homeAssetShape as { provision?: unknown } | null)?.provision).toBeUndefined();
      expect(typeof (homeAssetShape as { restore?: unknown } | null)?.restore).toBe("function");
      expect(stagedAuthContents).toBe(JSON.stringify({ live: "token" }));
    });

    it("sets GROK_HOME from assetDirs.home in a remote subscription run", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      await seedHostGrokAuth("{}");
      let seenEnv: Record<string, string> = {};
      runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
        seenEnv = options.env;
        return makeSuccessfulRunResult();
      });

      await execute(await makeCtx("run-remote-subscription-home", await makeTempRoot()));

      expect(seenEnv.GROK_HOME).toBe("/remote/workspace/.paperclip-runtime/grok/home");
    });

    it("uses the fallback remote path when assetDirs.home is absent", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      mocks.state.prepareRuntimeResult = { workspaceRemoteDir: "/remote/fallback-workspace", assetDirs: {} };
      await seedHostGrokAuth("{}");
      let seenEnv: Record<string, string> = {};
      runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
        seenEnv = options.env;
        return makeSuccessfulRunResult();
      });

      await execute(await makeCtx("run-remote-subscription-fallback", await makeTempRoot()));

      expect(seenEnv.GROK_HOME).toBe(
        "/remote/fallback-workspace/.paperclip-runtime/grok/home",
      );
    });

    it("passes no home asset and sets no GROK_HOME in a remote API-key run", async () => {
      process.env.XAI_API_KEY = "test-key";
      mocks.state.isRemote = true;
      let seenEnv: Record<string, string> = {};
      runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
        seenEnv = options.env;
        return makeSuccessfulRunResult();
      });

      await execute(await makeCtx("run-remote-api-key", await makeTempRoot()));

      expect(prepareRuntimeMock).toHaveBeenCalledTimes(1);
      const { assets } = prepareRuntimeMock.mock.calls[0][0] as { assets?: unknown[] };
      expect(assets).toBeUndefined();
      expect(seenEnv.GROK_HOME).toBeUndefined();
    });

    it("passes no home asset in a local run", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = false;
      runProcessMock.mockImplementation(async () => makeSuccessfulRunResult());

      await execute(await makeCtx("run-local-no-asset", await makeTempRoot()));

      expect(prepareRuntimeMock).not.toHaveBeenCalled();
    });

    it("removes the staged home after a successful remote subscription run", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      await seedHostGrokAuth("{}");
      let stagedDir = "";
      runProcessMock.mockImplementation(async () => makeSuccessfulRunResult());
      prepareRuntimeMock.mockImplementationOnce(async (input: { assets?: Array<{ localDir: string }> }) => {
        stagedDir = input.assets?.[0]?.localDir ?? "";
        return {
          workspaceRemoteDir: "/remote/workspace",
          assetDirs: { home: "/remote/workspace/.paperclip-runtime/grok/home" },
          restoreWorkspace: async () => {},
        };
      });

      await execute(await makeCtx("run-remote-cleanup-success", await makeTempRoot()));

      expect(stagedDir).not.toBe("");
      expect(await pathExists(stagedDir)).toBe(false);
    });

    it("removes the staged home after a setup failure in a remote subscription run", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      await seedHostGrokAuth("{}");
      let stagedDir = "";
      prepareRuntimeMock.mockImplementationOnce(async (input: { assets?: Array<{ localDir: string }> }) => {
        stagedDir = input.assets?.[0]?.localDir ?? "";
        return {
          workspaceRemoteDir: "/remote/workspace",
          assetDirs: { home: "/remote/workspace/.paperclip-runtime/grok/home" },
          restoreWorkspace: async () => {},
        };
      });
      ensureCommandMock.mockRejectedValueOnce(new Error("grok not installed remotely"));

      await expect(execute(await makeCtx("run-remote-cleanup-fail", await makeTempRoot()))).rejects.toThrow(
        "grok not installed remotely",
      );

      expect(stagedDir).not.toBe("");
      expect(await pathExists(stagedDir)).toBe(false);
    });

    it("removes the staged home when the workspace restore rejects during teardown", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      await seedHostGrokAuth("{}");
      let stagedDir = "";
      runProcessMock.mockImplementation(async () => makeSuccessfulRunResult());
      prepareRuntimeMock.mockImplementationOnce(async (input: { assets?: Array<{ localDir: string }> }) => {
        stagedDir = input.assets?.[0]?.localDir ?? "";
        return {
          workspaceRemoteDir: "/remote/workspace",
          assetDirs: { home: "/remote/workspace/.paperclip-runtime/grok/home" },
          restoreWorkspace: async () => {
            throw new Error("restore failed");
          },
        };
      });

      await expect(execute(await makeCtx("run-remote-teardown-restore-reject", await makeTempRoot()))).rejects.toThrow(
        "restore failed",
      );

      expect(stagedDir).not.toBe("");
      expect(await pathExists(stagedDir)).toBe(false);
    });

    it("a remote run copies the refreshed sandbox credential to the company Grok home", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      const hostGrokHome = await seedHostGrokAuth(grokAuth({ key: "host-key", expiresAt: OLDER_EXPIRY }));
      const refreshedAuth = grokAuth({ key: "refreshed-key", expiresAt: NEWER_EXPIRY });
      sandboxAuthFixture.bytes = Buffer.from(refreshedAuth, "utf8");
      runProcessMock.mockImplementation(async () => makeSuccessfulRunResult());
      prepareRuntimeMock.mockImplementationOnce(async (input: {
        assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean; provision?: unknown; restore?: unknown }>;
      }) => {
        const assets = (input.assets ?? []) as Array<{
          restore?: (ctx: { assetDir: string; readFile: (path: string) => Promise<Buffer> }) => Promise<void>;
        }>;
        return {
          workspaceRemoteDir: "/remote/workspace",
          assetDirs: { home: "/remote/workspace/.paperclip-runtime/grok/home" },
          restoreWorkspace: makeRestoreWorkspace(assets),
        };
      });

      await execute(await makeCtx("run-copyout-e2e", await makeTempRoot()));

      expect(await fs.readFile(path.join(hostGrokHome, "auth.json"), "utf8")).toBe(refreshedAuth);
    });

    it("the copy-out installs to the resolver directory when env.GROK_HOME names a different directory, and the named directory stays empty", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      const resolverDir = await seedHostGrokAuth(grokAuth({ key: "host-key", expiresAt: OLDER_EXPIRY }));
      const attackerDir = await makeTempRoot();
      const refreshedAuth = grokAuth({ key: "refreshed-key", expiresAt: NEWER_EXPIRY });
      sandboxAuthFixture.bytes = Buffer.from(refreshedAuth, "utf8");
      runProcessMock.mockImplementation(async () => makeSuccessfulRunResult());
      prepareRuntimeMock.mockImplementationOnce(async (input: {
        assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean; provision?: unknown; restore?: unknown }>;
      }) => {
        const assets = (input.assets ?? []) as Array<{
          restore?: (ctx: { assetDir: string; readFile: (path: string) => Promise<Buffer> }) => Promise<void>;
        }>;
        return {
          workspaceRemoteDir: "/remote/workspace",
          assetDirs: { home: "/remote/workspace/.paperclip-runtime/grok/home" },
          restoreWorkspace: makeRestoreWorkspace(assets),
        };
      });

      const ctx = await makeCtx("run-copyout-pinning", await makeTempRoot());
      ctx.config = { ...ctx.config, env: { GROK_HOME: attackerDir } };
      await execute(ctx);

      expect(await fs.readFile(path.join(resolverDir, "auth.json"), "utf8")).toBe(refreshedAuth);
      await expect(fs.readFile(path.join(attackerDir, "auth.json"), "utf8")).rejects.toThrow();
    });

    it("a copy-out failure does not fail the run", async () => {
      delete process.env.XAI_API_KEY;
      mocks.state.isRemote = true;
      const hostGrokHome = await seedHostGrokAuth(grokAuth({ key: "host-key", expiresAt: OLDER_EXPIRY }));
      sandboxAuthFixture.error = Object.assign(new Error("sandbox read boom"), { code: "EIO" });
      runProcessMock.mockImplementation(async () => makeSuccessfulRunResult());
      prepareRuntimeMock.mockImplementationOnce(async (input: {
        assets?: Array<{ key: string; localDir: string; followSymlinks?: boolean; provision?: unknown; restore?: unknown }>;
      }) => {
        const assets = (input.assets ?? []) as Array<{
          restore?: (ctx: { assetDir: string; readFile: (path: string) => Promise<Buffer> }) => Promise<void>;
        }>;
        return {
          workspaceRemoteDir: "/remote/workspace",
          assetDirs: { home: "/remote/workspace/.paperclip-runtime/grok/home" },
          restoreWorkspace: makeRestoreWorkspace(assets),
        };
      });

      const result = await execute(await makeCtx("run-copyout-failure", await makeTempRoot()));

      expect(result.exitCode).toBe(0);
      // The host credential is untouched by the failed copy-out.
      expect(await fs.readFile(path.join(hostGrokHome, "auth.json"), "utf8")).toBe(
        grokAuth({ key: "host-key", expiresAt: OLDER_EXPIRY }),
      );
    });
  });
});

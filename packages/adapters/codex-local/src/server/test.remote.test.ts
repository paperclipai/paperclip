import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
  prepareManagedCodexHome,
  restoreWorkspace,
  capturedHomeAssetFiles,
  capturedHomeAssetAuthJson,
} = vi.hoisted(() => {
  const restoreWorkspace = vi.fn(async () => {});
  // Records the files staged in the uploaded "home" asset at call time, before
  // the probe's cleanup deletes the temp dir. Lets tests assert the upload is a
  // minimal credentials-only home and not the full managed CODEX_HOME.
  const capturedHomeAssetFiles: { value: string[] | null } = { value: null };
  // Records the staged auth.json content, so tests can assert WHICH home's
  // credential the probe uploaded (the effective home a run would use).
  const capturedHomeAssetAuthJson: { value: string | null } = { value: null };
  return {
    capturedHomeAssetFiles,
    capturedHomeAssetAuthJson,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "QA SSH"),
    resolveAdapterExecutionTargetCwd: vi.fn((target, configuredCwd, fallbackCwd) => {
      if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) return configuredCwd;
      if (target && typeof target === "object" && "remoteCwd" in target && typeof target.remoteCwd === "string") {
        return target.remoteCwd;
      }
      return fallbackCwd;
    }),
    prepareAdapterExecutionTargetRuntime: vi.fn(async (input: { assets?: Array<{ key: string; localDir: string }> }) => {
      const homeAsset = input?.assets?.find((asset) => asset.key === "home");
      if (homeAsset) {
        capturedHomeAssetFiles.value = (await fs.readdir(homeAsset.localDir)).sort();
        capturedHomeAssetAuthJson.value = await fs
          .readFile(`${homeAsset.localDir}/auth.json`, "utf8")
          .catch(() => null);
      }
      return {
        target: null,
        workspaceRemoteDir: "/remote/workspace/.paperclip-runtime/runs/test/workspace",
        runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/codex",
        assetDirs: {
          home: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/codex/home",
        },
        restoreWorkspace,
      };
    }),
    prepareManagedCodexHome: vi.fn(async () => {
      // Return a real managed home seeded with credentials so the probe's
      // minimal-home copy step (auth.json/config.toml) has something to read.
      const dir = await fs.mkdtemp(`${os.tmpdir()}/paperclip-managed-codex-home-`);
      await fs.writeFile(`${dir}/auth.json`, JSON.stringify({ OPENAI_API_KEY: "sk-managed" }));
      await fs.writeFile(`${dir}/config.toml`, "model = \"gpt-5\"\n");
      return dir;
    }),
    restoreWorkspace,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
    prepareAdapterExecutionTargetRuntime,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    prepareManagedCodexHome,
  };
});

import { testEnvironment } from "./test.js";

describe("codex remote environment diagnostics", () => {
  const scratchDirs: string[] = [];

  async function makeScratchDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    scratchDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    // The probe mirrors execute's home preparation, which reads the shared
    // source home and the auth cache from `process.env`. Pin both to empty
    // scratch locations so no test ever reads or writes the real ~/.codex or
    // the real instance tree.
    vi.stubEnv("CODEX_HOME", await makeScratchDir("paperclip-test-shared-codex-"));
    vi.stubEnv("PAPERCLIP_HOME", await makeScratchDir("paperclip-test-instance-"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.OPENAI_API_KEY;
    capturedHomeAssetFiles.value = null;
    capturedHomeAssetAuthJson.value = null;
    while (scratchDirs.length > 0) {
      const dir = scratchDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("stages managed CODEX_HOME in an isolated runtime dir and keeps the probe cwd on the original remote workspace", async () => {
    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/remote/workspace",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "agent",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        strictHostKeyChecking: false,
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
      },
      executionTarget: remoteTarget,
      environmentName: "QA SSH",
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    expect(prepareManagedCodexHome).toHaveBeenCalledTimes(1);
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const runtimeCalls = prepareAdapterExecutionTargetRuntime.mock.calls as unknown as Array<[
      {
        workspaceLocalDir: string;
        target?: { remoteCwd?: string };
        workspaceRemoteDir?: string;
        assets?: Array<{ key: string; localDir: string }>;
      },
    ]>;
    const runtimeInput = runtimeCalls[0]?.[0];
    // The probe must upload only a minimal credentials-only home, never the
    // full managed CODEX_HOME (which can be hundreds of MB of session history).
    const homeAsset = runtimeInput?.assets?.find((asset) => asset.key === "home");
    expect(homeAsset?.localDir).toContain(`${os.tmpdir()}/paperclip-codex-probe-home-`);
    expect(capturedHomeAssetFiles.value).toEqual(["auth.json", "config.toml"]);
    expect(runtimeInput?.workspaceLocalDir).toContain(`${os.tmpdir()}/paperclip-codex-envtest-`);
    expect(runtimeInput?.workspaceLocalDir).not.toBe("/remote/workspace");
    expect(await fs.stat(runtimeInput!.workspaceLocalDir).catch(() => null)).toBeNull();
    expect(runtimeInput?.target?.remoteCwd).toBe("/remote/workspace");
    // `workspaceRemoteDir` is the base path passed to the runtime; the
    // helper's per-run subdirectory is appended internally inside
    // `prepareRemoteManagedRuntime`. Pre-building a per-run prefix here
    // would double-nest the run id in the final path.
    expect(runtimeInput?.workspaceRemoteDir).toBe("/remote/workspace");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, { kind: string; remoteCwd: string }, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[1]).toMatchObject({
      kind: "remote",
      remoteCwd: "/remote/workspace",
    });
    expect(probeCall?.[4]).toMatchObject({
      cwd: "/remote/workspace",
      env: expect.objectContaining({
        CODEX_HOME: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/codex/home",
      }),
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("avoids /tmp CODEX_HOME for remote API-key hello probes", async () => {
    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        env: {
          OPENAI_API_KEY: "sk-test",
        },
      },
      executionTarget: remoteTarget,
      environmentName: "QA Cloudflare",
    });

    expect(result.status).toBe("pass");
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, AdapterExecutionTarget, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[4].env.CODEX_HOME).toContain("/remote/workspace/.paperclip-runtime/codex/probe-home-codex-envtest-");
    expect(probeCall?.[4].env.CODEX_HOME?.startsWith("/tmp/")).toBe(false);
    expect(probeCall?.[3]).toContain("--skip-git-repo-check");
  });

  it("emits the canonical adapter_auth_missing check when a sandbox hello probe reports missing auth", async () => {
    // The sandbox has no seedable credentials, so the hello probe returns an
    // authentication-required error. The Test must emit the neutral canonical
    // check code. The user interface reads this code to decide login
    // eligibility; it does not parse the message text or the top-level status.
    prepareManagedCodexHome.mockImplementationOnce(async () => {
      const dir = await fs.mkdtemp(`${os.tmpdir()}/paperclip-managed-codex-home-noauth-`);
      await fs.writeFile(`${dir}/config.toml`, "model = \"gpt-5\"\n");
      return dir;
    });
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Not logged in. Please run `codex login` to authenticate.",
      pid: 321,
      startedAt: new Date().toISOString(),
    });

    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
      executionTarget: remoteTarget,
      environmentName: "QA Daytona",
    });

    // A missing-auth probe is a warning, not a failure, so the environment stays
    // testable and the user interface can offer login.
    expect(result.status).toBe("warn");
    expect(result.checks.some((check) => check.code === "adapter_auth_missing")).toBe(true);
    // The descriptive probe check stays, so existing diagnostics keep working.
    expect(result.checks.some((check) => check.code === "codex_hello_probe_auth_required")).toBe(true);
  });

  it("does not override CODEX_HOME when the host has no credentials to seed", async () => {
    // Custom-image flow: the login lives inside the captured snapshot, and the
    // host has no Codex auth.json. The probe must not upload an empty home or
    // set CODEX_HOME, so Codex falls back to the sandbox's baked-in login.
    prepareManagedCodexHome.mockImplementationOnce(async () => {
      const dir = await fs.mkdtemp(`${os.tmpdir()}/paperclip-managed-codex-home-noauth-`);
      // No auth.json — only a config file.
      await fs.writeFile(`${dir}/config.toml`, "model = \"gpt-5\"\n");
      return dir;
    });

    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: { engine: "cli", command: "codex" },
      executionTarget: remoteTarget,
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("pass");
    // No managed-home upload, so the full-runtime staging is skipped entirely.
    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, AdapterExecutionTarget, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[4].env.CODEX_HOME).toBeUndefined();
  });

  const subscriptionAuth = (accountId: string, marker: string, lastRefresh: string) =>
    JSON.stringify({
      tokens: {
        id_token: `synthetic-id-token-${marker}`,
        access_token: `synthetic-access-token-${marker}`,
        refresh_token: `synthetic-refresh-token-${marker}`,
        account_id: accountId,
      },
      last_refresh: lastRefresh,
    });

  function sandboxTarget(): AdapterExecutionTarget {
    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: "daytona",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };
  }

  it("stages a configured managed per-agent CODEX_HOME instead of the company default home", async () => {
    // Execute honors env.CODEX_HOME, so the probe must exercise that same home
    // — otherwise the Test and real runs authenticate with different
    // credentials and can disagree in both directions.
    const perAgentHome = path.join(
      process.env.PAPERCLIP_HOME!,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-x",
      "codex-home",
    );
    const promoted = subscriptionAuth("acct-agent", "promoted", "2026-07-09T02:00:00Z");
    await fs.mkdir(perAgentHome, { recursive: true });
    await fs.writeFile(path.join(perAgentHome, "auth.json"), promoted, "utf8");
    await fs.writeFile(path.join(perAgentHome, "config.toml"), 'model = "gpt-5"\n', "utf8");

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        env: { CODEX_HOME: perAgentHome },
      },
      executionTarget: sandboxTarget(),
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("pass");
    // The company default home preparation never ran; the configured managed
    // home was seeded in place and its credential is what got staged.
    expect(prepareManagedCodexHome).not.toHaveBeenCalled();
    expect(capturedHomeAssetAuthJson.value).toBe(promoted);
    // The real seeding pass ran on the per-agent home and kept the promoted
    // regular-file credential (the shared source scratch home is empty).
    const stat = await fs.lstat(path.join(perAgentHome, "auth.json"));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(perAgentHome, "auth.json"), "utf8")).toBe(promoted);
  });

  it("stages an external CODEX_HOME's credentials as-is and never seeds or mutates it", async () => {
    const externalHome = await makeScratchDir("paperclip-test-external-codex-");
    const external = subscriptionAuth("acct-ext", "external", "2026-07-09T01:00:00Z");
    await fs.writeFile(path.join(externalHome, "auth.json"), external, "utf8");
    // Plant a same-identity, strictly-fresher credential in the shared source
    // home: if the probe wrongly ran the managed seeding pass on the external
    // home, the heal would swap its auth.json for a symlink to this file. The
    // regular-file assertion below is therefore proof no seeding happened.
    await fs.writeFile(
      path.join(process.env.CODEX_HOME!, "auth.json"),
      subscriptionAuth("acct-ext", "shared", "2026-07-09T02:00:00Z"),
      "utf8",
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        engine: "cli",
        command: "codex",
        env: { CODEX_HOME: externalHome },
      },
      executionTarget: sandboxTarget(),
      environmentName: "QA Daytona",
    });

    expect(result.status).toBe("pass");
    expect(prepareManagedCodexHome).not.toHaveBeenCalled();
    // The external home's own credential is what got staged — not the shared
    // source's fresher copy, because an external override manages its own auth.
    expect(capturedHomeAssetAuthJson.value).toBe(external);
    const stat = await fs.lstat(path.join(externalHome, "auth.json"));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(externalHome, "auth.json"), "utf8")).toBe(external);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, posix } from "node:path";
const { execute, probe, nativeProbe, remoteManifest, configuredManifest, bundledRunner, runnerBinding, selectedRunner, sshExecute, sshRunner, nativeArtifacts, remoteLauncher, registerPrp } = vi.hoisted(() => ({ execute: vi.fn(), probe: vi.fn(), nativeProbe: vi.fn(), remoteManifest: vi.fn(), configuredManifest: vi.fn(), bundledRunner: vi.fn(), runnerBinding: vi.fn(), selectedRunner: vi.fn(), sshExecute: vi.fn(), sshRunner: vi.fn(), nativeArtifacts: vi.fn(), remoteLauncher: vi.fn(), registerPrp: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetShellCommand: execute }));
vi.mock("./native-ssh-command-runner.js", () => ({ createNativeSshCommandRunner: sshRunner }));
vi.mock("../../realtime/runner-prp-ws.js", () => ({ registerRunnerPrpAuthority: registerPrp }));
vi.mock("./native-codex-runner.js", () => ({ resolvePaperclipRunnerBinary: selectedRunner }));
vi.mock("../../vendor/paperclip-runner/index.js", async (original) => ({ ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(), probeQualifiedAcpxEnvironment: probe, probeNativeRunnerEnvironment: nativeProbe,
  bundledRemoteRunnerBinary: bundledRunner, readRunnerdArtifactBinding: runnerBinding }));
vi.mock("./native-session-executor.js", async original => ({ ...await original<typeof import("./native-session-executor.js")>(), readBundledRemoteProviderPackManifest: remoteManifest, readRemoteProviderPackManifest: configuredManifest, createRemoteNativeArtifactPreparation: nativeArtifacts, createRemoteRunnerProcessLauncher: remoteLauncher }));
import { QUALIFIED_ACPX_PROFILES, acpxRuntimeSessionDirectoryName, resolveQualifiedAcpxProfile } from "../../vendor/paperclip-runner/index.js";
import { assertNativeRunnerSetupReady, assertRemoteAcpxSetupReady, testNativeAcpxAuthentication, testNativeRunnerAuthentication, withRemoteNativeSetupArtifacts, type RemoteNativeSetupArtifacts } from "./setup-readiness.js";
import { requireVerifiedAcpxModel } from "../../vendor/paperclip-runner/testing.js";
const context = {
  companyId: "company", adapterType: "paperclip_runner", config: {},
  executionTarget: { kind: "remote" as const, transport: "sandbox" as const, providerKey: "test", remoteCwd: "/workspace", runner: { execute: vi.fn() } },
};
describe("selected environment runtime readiness", () => {
  beforeEach(() => execute.mockReset());
  it("requires a compatible runner binary", async () => {
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ binaryName: "paperclip-runnerd", prp: { minimumVersion: 1, maximumVersion: 1 } }), stderr: "" });
    await expect(assertNativeRunnerSetupReady(context)).resolves.toBeUndefined();
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ binaryName: "other" }), stderr: "" });
    await expect(assertNativeRunnerSetupReady(context)).rejects.toThrow("incompatible");
  });
  it("reports missing dependencies without switching runner", async () => {
    execute.mockResolvedValue({ exitCode: 127, timedOut: false, stdout: "", stderr: "not found" });
    await expect(assertNativeRunnerSetupReady(context)).rejects.toThrow("Legacy runner in Advanced");
    await expect(assertRemoteAcpxSetupReady(context, "claude", "claude-sonnet-5")).rejects.toThrow("provider pack");
  });
  it("probes the provider pack on the same target without sending credentials", async () => {
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    await assertRemoteAcpxSetupReady(context, "cursor", "model'with-quote");
    expect(execute).toHaveBeenCalledWith(expect.any(String), context.executionTarget, expect.stringContaining("probeAcpxCursorInstallation"), { cwd: "/workspace", env: {}, timeoutSec: 30 });
    const command = execute.mock.calls[0][2] as string;
    expect(command).toContain("qualified-profiles.js");
    expect(command).not.toContain("CURSOR_API_KEY");
  });
});

describe("sandbox setup task artifact preparation", () => {
  const manifest = { payload: { target: { platform: "linux", architecture: "x64" }, artifacts: { nodeCommand: { path: "node_modules/node/bin/node" }, opencodeCommand: { path: "node_modules/.bin/opencode" } } } };
  let uploaded = false;
  let corruptUpload = false;
  let preinstalled = false;
  const syncIn = vi.fn();
  const runnerExecute = vi.fn();
  const passedProbe = async (artifacts?: RemoteNativeSetupArtifacts) => {
    artifacts?.onCleanupConfirmed?.();
    return { adapterType: "paperclip_runner", status: "pass" as const, testedAt: "", checks: [] };
  };
  const selected = { ...context, config: { env: { OPENAI_API_KEY: "selected-secret", ANTHROPIC_API_KEY: "selected-anthropic" } }, executionTarget: {
    ...context.executionTarget, remoteCwd: "/selected workspace'qa", runner: { execute: runnerExecute, syncIn },
  } };
  beforeEach(() => {
    uploaded = false; corruptUpload = false; preinstalled = false;
    execute.mockReset(); nativeProbe.mockReset(); probe.mockReset();
    sshRunner.mockReset().mockReturnValue({ execute: runnerExecute });
    nativeArtifacts.mockReset().mockReturnValue({ prepare: vi.fn().mockResolvedValue(undefined) });
    configuredManifest.mockReset().mockReturnValue(manifest);
    remoteManifest.mockReset().mockReturnValue(manifest);
    runnerBinding.mockReset().mockReturnValue({ version: "1", digest: "sha256:" + "a".repeat(64) });
    selectedRunner.mockReset().mockReturnValue("/controller/bin/paperclip-runnerd");
    bundledRunner.mockReset().mockReturnValue("/release/linux-x64/paperclip-runnerd");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/controller/provider-pack");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_CODEX_PATH", "");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC", "");
    syncIn.mockReset().mockImplementation(async () => { uploaded = true; });
    runnerExecute.mockReset().mockImplementation(async input => {
      if (input.args?.includes("uname -s && uname -m")) return { exitCode: 0, timedOut: false, stdout: "Linux\nx86_64\n", stderr: "" };
      if (input.args?.[1]?.startsWith("for candidate in")) return { exitCode: 0, timedOut: false, stdout: preinstalled ? "/opt/paperclip-runner/provider-pack\n" : "", stderr: "" };
      if (input.args?.[0] === "-e") return { exitCode: (uploaded && !corruptUpload) || (preinstalled && input.command.startsWith("/opt/")) ? 0 : 1, timedOut: false, stdout: "", stderr: "manifest mismatch or missing pack" };
      return { exitCode: 0, timedOut: false, stdout: input.args?.[0] === "--version" ? "1.18.34\n" : "", stderr: "" };
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(["codex", "opencode", "acpx"] as const)("stages release-bound artifacts for %s when fixed image paths are absent", async provider => {
    const result = await withRemoteNativeSetupArtifacts(selected, provider, "chosen-model", async artifacts => {
      expect(artifacts).toMatchObject({ controllerRunnerBinary: "/controller/bin/paperclip-runnerd", manifest });
      const root = posix.dirname(artifacts!.providerPackRoot);
      expect(root).toMatch(/^\/selected workspace'qa\/.paperclip-runtime\/paperclip-native-setup-/);
      expect(nativeArtifacts.mock.results[0]!.value.prepare).toHaveBeenCalledWith("dial_wss");
      expect(syncIn).toHaveBeenCalledOnce();
      const descriptor = syncIn.mock.calls[0][0][0].files[0];
      expect(descriptor).toEqual({ sourcePath: "/controller/provider-pack", targetPath: artifacts!.providerPackRoot, kind: "directory", mode: 0o700 });
      execute.mockImplementation(async (_id, _target, command) => {
        execFileSync("sh", ["-n", "-c", command]);
        if (command.includes("--build-metadata")) return { exitCode: 0, timedOut: false, stdout: JSON.stringify({ binaryName: "paperclip-runnerd", prp: { minimumVersion: 1, maximumVersion: 1 } }), stderr: "" };
        if (command.includes("probeAcpxClaudeInstallation")) return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
        return { exitCode: 0, timedOut: false, stdout: JSON.stringify(provider === "acpx"
          ? { helloProbePassed: true, effectiveModel: "chosen-model", commandDigest: QUALIFIED_ACPX_PROFILES.claude.commandDigest, cleanupConfirmed: true }
          : { provider, helloProbePassed: true, effectiveModel: "chosen-model", providerDriver: provider === "codex" ? "codex_app_server" : "opencode_server", cleanupConfirmed: true }), stderr: "" };
      });
      await assertNativeRunnerSetupReady(selected, artifacts);
      if (provider === "acpx") await assertRemoteAcpxSetupReady(selected, "claude", "chosen-model", artifacts);
      const authenticated = provider === "acpx" ? await testNativeAcpxAuthentication(selected, "claude", "chosen-model", artifacts)
        : await testNativeRunnerAuthentication(selected, provider, "chosen-model", artifacts);
      expect(authenticated.status).toBe("pass");
      for (const [, target, command, options] of execute.mock.calls) {
        expect(target).toBe(selected.executionTarget);
        expect(options.cwd).toBe(selected.executionTarget.remoteCwd);
        expect(command).toContain(root.replaceAll("'", "'\\''"));
        expect(command).not.toContain("for pack in /opt/");
        expect(command).not.toContain("selected-secret");
        expect(command).not.toContain("selected-anthropic");
      }
      return authenticated;
    });
    expect(result.status).toBe("pass");
    expect(runnerExecute.mock.calls.at(-1)![0]).toMatchObject({ command: "rm", args: ["-rf", "--", expect.stringContaining("paperclip-native-setup-")] });
    expect(JSON.stringify(syncIn.mock.calls)).not.toContain("selected-secret");
    expect(nativeArtifacts).toHaveBeenCalledWith(expect.objectContaining({ target: selected.executionTarget, runner: selected.executionTarget.runner,
      ...(provider === "codex" ? { model: "chosen-model", remoteCodexBinary: expect.stringMatching(/\/bin\/codex$/) } : { model: null }) }));
  });
  it("uses a fully verified preinstalled pack without an unnecessary upload", async () => {
    preinstalled = true;
    expect((await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", passedProbe)).status).toBe("pass");
    expect(syncIn).not.toHaveBeenCalled();
    expect(runnerExecute.mock.calls.some(([input]) => input.args?.[1]?.includes("ln -s"))).toBe(true);
  });
  it("replaces a mismatched preinstalled pack only with the verified controller upload", async () => {
    preinstalled = true;
    const original = runnerExecute.getMockImplementation()!;
    runnerExecute.mockImplementation(async input => input.args?.[0] === "-e" && input.command.startsWith("/opt/")
      ? { exitCode: 1, timedOut: false, stdout: "", stderr: "manifest mismatch" } : original(input));
    const authenticate = vi.fn(passedProbe);
    expect((await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", authenticate)).status).toBe("pass");
    expect(syncIn).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledOnce();
    expect(runnerExecute.mock.calls.some(([input]) => input.args?.[1]?.includes("ln -s"))).toBe(false);
  });
  it("verifies a bundled manifest against a preinstalled pack when no upload source is configured", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "");
    preinstalled = true;
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", async artifacts => {
      expect(artifacts!.controllerRunnerBinary).toBe("/release/linux-x64/paperclip-runnerd");
      expect(artifacts!.manifest).toEqual(manifest);
      return passedProbe(artifacts);
    });
    expect(result.status).toBe("pass");
    expect(configuredManifest).not.toHaveBeenCalled();
    expect(remoteManifest).toHaveBeenCalledOnce();
    expect(syncIn).not.toHaveBeenCalled();
  });
  it("reports a missing matching image pack when no controller upload source is configured", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "");
    const authenticate = vi.fn();
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", authenticate);
    expect(result.status).toBe("fail");
    expect(result.checks[0].message).toContain("image provider pack did not match");
    expect(authenticate).not.toHaveBeenCalled();
    expect(syncIn).not.toHaveBeenCalled();
    expect(runnerExecute.mock.calls.at(-1)![0]).toMatchObject({ command: "rm", args: ["-rf", "--", expect.stringContaining("paperclip-native-setup-")] });
  });
  it.each(["controller-pack", "controller-runner", "platform", "upload-capability", "upload", "uploaded-manifest", "daemon"])("fails before authentication for incompatible %s artifacts", async failure => {
    const authenticate = vi.fn();
    let target = selected;
    if (failure === "controller-pack") configuredManifest.mockImplementation(() => { throw new Error("Controller provider-pack manifest mismatch"); });
    if (failure === "controller-runner") runnerBinding.mockImplementation(() => { throw new Error("Controller runner unavailable"); });
    if (failure === "platform") configuredManifest.mockReturnValue({ ...manifest, payload: { ...manifest.payload, target: { platform: "darwin", architecture: "arm64" } } });
    if (failure === "upload-capability") target = { ...selected, executionTarget: { ...selected.executionTarget, runner: { execute: runnerExecute } } } as typeof selected;
    if (failure === "upload") syncIn.mockRejectedValue(new Error("Upload failed"));
    if (failure === "uploaded-manifest") corruptUpload = true;
    if (failure === "daemon") nativeArtifacts.mockReturnValue({ prepare: vi.fn().mockRejectedValue(new Error("Daemon digest mismatch")) });
    const result = await withRemoteNativeSetupArtifacts(target, "opencode", "chosen-model", authenticate);
    expect(result.status).toBe("fail");
    expect(result.checks[0].hint).toContain("Legacy runner is available explicitly");
    expect(authenticate).not.toHaveBeenCalled();
    expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(!["controller-pack", "controller-runner", "platform"].includes(failure));
    if (["controller-pack", "controller-runner"].includes(failure)) expect(runnerExecute).not.toHaveBeenCalled();
    if (failure === "platform") expect(nativeArtifacts).not.toHaveBeenCalled();
  });
  it("retains artifact state for failed authentication or unconfirmed provider cleanup", async () => {
    const result = await withRemoteNativeSetupArtifacts(selected, "codex", "chosen-model", async artifacts => {
      execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ provider: "codex", helloProbePassed: true, effectiveModel: "chosen-model", providerDriver: "codex_app_server", cleanupConfirmed: false }), stderr: "" });
      return testNativeRunnerAuthentication(selected, "codex", "chosen-model", artifacts);
    });
    expect(result.status).toBe("fail");
    expect(result.checks[0].message).toContain("cleanup is incomplete");
    expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(false);
  });
  it.each([true, false, undefined, "[REDACTED]"])("cleans a failed native account probe only with explicit teardown proof (%s)", async cleanupConfirmed => {
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ nativeProbeError: "Authentication failed: selected-secret", cleanupConfirmed }), stderr: "" });
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", artifacts => testNativeRunnerAuthentication(selected, "opencode", "chosen-model", artifacts));
    expect(result).toMatchObject({ status: "fail", checks: [expect.objectContaining({ code: "opencode_hello_probe_auth_required", message: "Authentication failed: [REDACTED]" }),
      ...(cleanupConfirmed === true ? [] : [expect.objectContaining({ code: "paperclip_runner_setup_state_retained", hint: expect.stringContaining("paperclip-native-setup-") })])] });
    expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(cleanupConfirmed === true);
    expect(JSON.stringify(result)).not.toContain("selected-secret");
  });
  it("does not infer cleanup from a passing result without teardown confirmation", async () => {
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", async () => ({ adapterType: "paperclip_runner", status: "pass", testedAt: "", checks: [] }));
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "paperclip_runner_setup_state_retained" }] });
    expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(false);
  });
  it.each([false, true])("preserves failed ACPX authentication and honors its teardown receipt (%s)", async cleanupConfirmed => {
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ nativeProbeError: "Authentication failed: selected-anthropic", cleanupConfirmed }), stderr: "" });
    const result = await withRemoteNativeSetupArtifacts(selected, "acpx", "chosen-model", artifacts => testNativeAcpxAuthentication(selected, "claude", "chosen-model", artifacts));
    expect(result.checks[0]).toMatchObject({ code: "claude_hello_probe_auth_required", message: "Authentication failed: [REDACTED]" });
    expect(result.status).toBe("fail");
    expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(cleanupConfirmed);
    expect(JSON.stringify(result)).not.toContain("selected-anthropic");
  });
  it("retains a claimed root when a probe throws without teardown proof", async () => {
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", async () => { throw new Error("Authentication failed: selected-secret"); });
    expect(result.status).toBe("fail");
    expect(result.checks[0].message).toBe("Authentication failed: [REDACTED]");
    expect(result.checks[1]).toMatchObject({ code: "paperclip_runner_setup_state_retained", hint: expect.stringContaining("paperclip-native-setup-") });
    expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(false);
  });
  it("retains staged artifacts if credential copy-back fails after confirmed provider teardown", async () => {
    const home = await mkdtemp(join(tmpdir(), "native-setup-copyback-control-"));
    try {
      await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: "qa-account", access_token: "old-token", refresh_token: "old-refresh" } }), { mode: 0o600 });
      const selectedAccount = { ...selected, managedAiCredentialHome: home, config: { env: {} } };
      execute.mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ nativeProbeError: "Authentication failed", cleanupConfirmed: true, runtimeDirectory: "/tmp/paperclip-native-setup-QA123", codexCredentialRefreshPath: "/tmp/paperclip-native-setup-QA123/codex-home/auth.json" }), stderr: "" })
        .mockResolvedValueOnce({ exitCode: 1, timedOut: false, stdout: "", stderr: "credential unavailable" });
      const result = await withRemoteNativeSetupArtifacts(selectedAccount, "codex", "chosen-model", artifacts => testNativeRunnerAuthentication(selectedAccount, "codex", "chosen-model", artifacts));
      expect(result).toMatchObject({ status: "fail", checks: [expect.objectContaining({ code: "codex_hello_probe_auth_required", message: expect.stringContaining("credential refresh handoff unavailable") }), expect.objectContaining({ code: "paperclip_runner_setup_state_retained" })] });
      expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(false);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain("old-token");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each([false, true])("does not delete an unclaimed root after an unsuccessful private-directory claim (timeout: %s)", async timedOut => {
    const original = runnerExecute.getMockImplementation()!;
    runnerExecute.mockImplementation(async input => input.args?.[1]?.includes("mkdir -m 0700")
      ? { exitCode: 1, timedOut, stdout: "", stderr: "unconfirmed claim" } : original(input));
    const authenticate = vi.fn(passedProbe);
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", authenticate);
    expect(result.checks[0].message).toContain("could not claim a private runtime directory");
    expect(authenticate).not.toHaveBeenCalled();
    expect(nativeArtifacts.mock.results[0]!.value.prepare).not.toHaveBeenCalled();
    expect(runnerExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(false);
  });
  it.each(["reject", "exit", "timeout"])("preserves the staging failure when claimed-root cleanup also fails (%s)", async failure => {
    const original = runnerExecute.getMockImplementation()!;
    nativeArtifacts.mockReturnValue({ prepare: vi.fn().mockRejectedValue(new Error("Daemon digest mismatch: selected-secret")) });
    runnerExecute.mockImplementation(async input => {
      if (input.command !== "rm") return original(input);
      if (failure === "reject") throw new Error("private transport output: selected-secret");
      return { exitCode: failure === "exit" ? 1 : 0, timedOut: failure === "timeout", stdout: "", stderr: "selected-secret" };
    });
    const authenticate = vi.fn(passedProbe);
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", authenticate);
    expect(result).toMatchObject({ status: "fail", checks: [expect.objectContaining({ code: "paperclip_runner_runtime_unavailable", message: "Daemon digest mismatch: [REDACTED]" }), expect.objectContaining({ code: "paperclip_runner_setup_cleanup_failed", hint: expect.stringContaining("paperclip-native-setup-") })] });
    expect(authenticate).not.toHaveBeenCalled();
    expect(runnerExecute.mock.calls.filter(([input]) => input.command === "rm")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("selected-secret");
    expect(result.checks[1].hint).toContain("Confirm provider teardown and credential handoff");
  });
  it("reports owned artifact cleanup failure without a readiness pass", async () => {
    const original = runnerExecute.getMockImplementation()!;
    runnerExecute.mockImplementation(async input => input.command === "rm" ? { exitCode: 1, timedOut: false, stdout: "", stderr: "busy" } : original(input));
    const result = await withRemoteNativeSetupArtifacts(selected, "opencode", "chosen-model", passedProbe);
    expect(result.status).toBe("fail");
    expect(result.checks.at(-1)).toMatchObject({ code: "paperclip_runner_setup_cleanup_failed", hint: expect.stringContaining("paperclip-native-setup-") });
  });
  it.each(["opencode", "acpx"] as const)("prepares qualified SSH %s through the same task path", async provider => {
    preinstalled = true;
    const sshTarget = { kind: "remote" as const, transport: "ssh" as const, remoteCwd: selected.executionTarget.remoteCwd,
      spec: { host: "qa-host", username: "qa-user", port: 22, remoteCwd: selected.executionTarget.remoteCwd, remoteWorkspacePath: selected.executionTarget.remoteCwd, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    const result = await withRemoteNativeSetupArtifacts({ ...selected, executionTarget: sshTarget }, provider, "chosen-model", async artifacts => {
      expect(artifacts!.providerPackRoot).toContain(sshTarget.remoteCwd);
      expect(nativeArtifacts.mock.results[0]!.value.prepare).toHaveBeenCalledWith("dial_wss");
      return passedProbe(artifacts);
    });
    expect(result.status).toBe("pass");
    expect(sshRunner).toHaveBeenCalledWith({ spec: sshTarget.spec, defaultCwd: sshTarget.remoteCwd });
    expect(syncIn).not.toHaveBeenCalled();
    expect(runnerExecute.mock.calls.at(-1)![0]).toMatchObject({ command: "rm", args: ["-rf", "--", expect.stringContaining("paperclip-native-setup-")] });
  });
  it.each(["missing-pack", "cleanup-failed"])("keeps SSH %s actionable without an unsupported upload fallback", async failure => {
    const sshTarget = { kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/ssh-workspace",
      spec: { host: "qa-host", username: "qa-user", port: 22, remoteCwd: "/ssh-workspace", remoteWorkspacePath: "/ssh-workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    if (failure === "cleanup-failed") {
      preinstalled = true;
      const original = runnerExecute.getMockImplementation()!;
      runnerExecute.mockImplementation(async input => input.command === "rm" ? { exitCode: 1, timedOut: false, stdout: "", stderr: "busy" } : original(input));
    }
    const authenticate = vi.fn(passedProbe);
    const result = await withRemoteNativeSetupArtifacts({ ...selected, executionTarget: sshTarget }, "opencode", "chosen-model", authenticate);
    expect(result.status).toBe("fail");
    expect(result.checks[0].message).toContain(failure === "missing-pack" ? "cannot stage a provider pack" : "cleanup is incomplete");
    expect(syncIn).not.toHaveBeenCalled();
    if (failure === "missing-pack") expect(authenticate).not.toHaveBeenCalled();
    expect(runnerExecute.mock.calls.at(-1)![0]).toMatchObject({ command: "rm", args: ["-rf", "--", expect.stringContaining("paperclip-native-setup-")] });
  });
  it("honors controller-owned explicit daemon and Codex sources and the target transport mode", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "/controller/explicit/runnerd");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_CODEX_PATH", "/controller/explicit/codex");
    const ingressTarget = { ...selected, executionTarget: { ...selected.executionTarget, effectiveCapabilities: { runnerWebSocketIngress: true } } } as typeof selected;
    await withRemoteNativeSetupArtifacts(ingressTarget, "codex", "chosen-model", passedProbe);
    expect(nativeArtifacts).toHaveBeenCalledWith(expect.objectContaining({ controllerRunnerBinary: "/controller/explicit/runnerd", runnerRemoteBinaryPath: "/controller/explicit/runnerd", runnerRemoteCodexPath: "/controller/explicit/codex" }));
    expect(nativeArtifacts.mock.results[0]!.value.prepare).toHaveBeenCalledWith("listen_ws");
  });
});

describe("Codex and OpenCode selected native account verification", () => {
  const receipt = (provider: "codex" | "opencode", model: string | null) => ({ provider, effectiveModel: model, providerDriver: provider === "codex" ? "codex_app_server" : "opencode_server", helloProbePassed: true, cleanupConfirmed: true });
  beforeEach(() => {
    execute.mockReset(); nativeProbe.mockReset();
    sshExecute.mockReset().mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    sshRunner.mockReset().mockReturnValue({ execute: sshExecute });
    nativeArtifacts.mockReset().mockReturnValue({ prepare: vi.fn().mockResolvedValue(undefined) });
    remoteLauncher.mockReset().mockReturnValue(vi.fn());
    registerPrp.mockReset().mockImplementation(async () => ({ release: vi.fn() }));
    vi.stubEnv("PAPERCLIP_RUNNER_PUBLIC_URL", "wss://paperclip.example.test");
    vi.stubEnv("PAPERCLIP_RUNNER_CA_BUNDLE_PATH", "");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_CODEX_PATH", "");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC", "");
    remoteManifest.mockReset().mockReturnValue({ payload: { artifacts: { nodeCommand: { path: "node_modules/node/bin/node" } } } });
    configuredManifest.mockReset().mockReturnValue({ payload: { artifacts: { nodeCommand: { path: "node_modules/node/bin/node" } } } });
    bundledRunner.mockReset().mockReturnValue("/release/linux-x64/paperclip-runnerd");
    selectedRunner.mockReset().mockReturnValue("/fixture/bin/paperclip-runnerd");
    runnerBinding.mockReset().mockReturnValue({ version: "1", digest: "sha256:" + "a".repeat(64) });
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const [input] of nativeProbe.mock.calls) if (input.runtimeDirectory) await rm(input.runtimeDirectory, { recursive: true, force: true });
  });
  it.each([["codex", "gpt-6.1-sol", "OPENAI_API_KEY"], ["opencode", "openrouter/example/model", "OPENROUTER_API_KEY"]] as const)("requires the native %s host and only the selected credential", async (provider, model, key) => {
    vi.stubEnv(key, "ambient-account");
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-anthropic");
    nativeProbe.mockImplementation(async input => { await input.onCleanupConfirmed(); return receipt(provider, model); });
    const result = await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: { env: { [key]: "bound-account" }, modelReasoningEffort: "low" } }, provider, model);
    expect(result.status).toBe("pass");
    const input = nativeProbe.mock.calls[0][0];
    expect(input).toMatchObject({ provider, model, timeoutMs: 45_000, environment: { [key]: "bound-account" } });
    expect(input.transportOptions.runnerBinary).toBe("/fixture/bin/paperclip-runnerd");
    expect(selectedRunner).toHaveBeenCalledOnce();
    expect(input.environment.ANTHROPIC_API_KEY).toBeUndefined();
    if (provider === "codex") expect(input.reasoningEffort).toBe("low");
    else expect(input.reasoningEffort).toBeUndefined();
    await expect(stat(input.runtimeDirectory)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["host-home", "host-codex-home", "configured-home", "managed-home"] as const)("reuses the task's authorized local Codex home before isolation (%s)", async mode => {
    vi.stubEnv("HOME", "/host-home");
    vi.stubEnv("CODEX_HOME", mode === "host-home" ? "" : "/host-codex");
    vi.stubEnv("OPENAI_API_KEY", "ambient-key-is-not-authorized");
    nativeProbe.mockResolvedValue(receipt("codex", "observed-model"));
    const config = mode === "configured-home" || mode === "managed-home" ? { env: { CODEX_HOME: "/configured-codex" } } : {};
    expect((await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config,
      ...(mode === "managed-home" ? { managedAiCredentialHome: "/managed-codex" } : {}) }, "codex", null)).status).toBe("pass");
    const input = nativeProbe.mock.calls[0][0];
    expect(input.transportOptions.sourceCodexHome).toBe({ "host-home": "/host-home/.codex", "host-codex-home": "/host-codex", "configured-home": "/configured-codex", "managed-home": "/managed-codex" }[mode]);
    expect(input.environment.OPENAI_API_KEY).toBeUndefined();
    expect(input.environment.HOME).toBeUndefined();
    expect(input.runtimeDirectory).not.toContain("host-home");
  });
  const sshContext = { companyId: "company", adapterType: "paperclip_runner", config: {}, executionTarget: {
    kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/qa-workspace", spec: { host: "qa-host", username: "qa-user", port: 22, remoteCwd: "/qa-workspace", remoteWorkspacePath: "/qa-workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true },
  } };
  it("uses task staging and the company-scoped native SSH transport without a provider pack", async () => {
    remoteManifest.mockImplementation(() => { throw new Error("SSH has no provider pack"); });
    bundledRunner.mockImplementation(() => { throw new Error("SSH has no npm release manifest"); });
    let released = false;
    registerPrp.mockResolvedValue({ release: async () => { released = true; } });
    nativeProbe.mockImplementation(async input => {
      const registration = await input.transportOptions.controlPlaneRegistration({ marker: "native-authority" });
      expect(registration.connection).toMatchObject({ mode: "connect", connectUrl: expect.stringMatching(/^wss:\/\/paperclip\.example\.test\/api\/runner\/v1\/connect\//) });
      await registration.release();
      await input.onCleanupConfirmed();
      return receipt("codex", "gpt-6.1-sol");
    });
    expect((await testNativeRunnerAuthentication({ ...sshContext, config: { env: { OPENAI_API_KEY: "company-account" }, modelReasoningEffort: "low" } }, "codex", "gpt-6.1-sol")).status).toBe("pass");
    const input = nativeProbe.mock.calls[0][0];
    expect(input).toMatchObject({ reasoningEffort: "low", environment: { OPENAI_API_KEY: "company-account" }, workingDirectory: expect.stringMatching(/^\/qa-workspace\/.paperclip-runtime\/paperclip-native-setup-.*\/filesystem\/workspace$/) });
    expect(input.transportOptions).toMatchObject({ runnerBinary: "/fixture/bin/paperclip-runnerd", codexCommand: expect.stringMatching(/\/bin\/codex$/), runnerFilesystemRoot: expect.stringMatching(/\/filesystem$/) });
    expect(nativeArtifacts).toHaveBeenCalledWith(expect.objectContaining({ controllerRunnerBinary: "/fixture/bin/paperclip-runnerd", model: "gpt-6.1-sol" }));
    expect(nativeArtifacts.mock.results[0]!.value.prepare).toHaveBeenCalledWith("dial_wss");
    expect(registerPrp).toHaveBeenCalledWith({ companyId: "company", runId: input.transportOptions.prpIdentity.runId, authority: { marker: "native-authority" } });
    expect(remoteLauncher).toHaveBeenCalledWith(expect.objectContaining({ runnerInstanceId: input.transportOptions.prpIdentity.runnerInstanceId }));
    expect(released).toBe(true);
    expect(sshExecute.mock.calls.at(-1)![0]).toMatchObject({ command: "rm", args: ["-rf", "--", expect.stringContaining("paperclip-native-setup-")] });
    expect(sshExecute.mock.calls.some(([value]) => JSON.stringify(value).includes("company-account"))).toBe(false);
    expect(remoteManifest).not.toHaveBeenCalled(); expect(configuredManifest).not.toHaveBeenCalled(); expect(bundledRunner).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it.each(["runtime missing", "authentication failed: selected-key", "no native completion", "model mismatch"])("fails SSH native setup without a legacy fallback (%s)", async message => {
    nativeProbe.mockRejectedValue(new Error(message));
    const result = await testNativeRunnerAuthentication({ ...sshContext, config: { env: { OPENAI_API_KEY: "selected-key" } } }, "codex", "gpt-6.1-sol");
    expect(result.status).toBe("fail"); expect(JSON.stringify(result)).not.toContain("selected-key");
    expect(nativeProbe).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
    expect(sshExecute.mock.calls.some(([value]) => value.command === "rm")).toBe(false);
    expect((await stat(nativeProbe.mock.calls[0][0].runtimeDirectory)).isDirectory()).toBe(true);
  });
  it("fails SSH transport eligibility before staging or opening the native provider", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_PUBLIC_URL", "");
    expect((await testNativeRunnerAuthentication(sshContext, "codex", null)).status).toBe("fail");
    expect(sshExecute).not.toHaveBeenCalled(); expect(nativeArtifacts).not.toHaveBeenCalled(); expect(nativeProbe).not.toHaveBeenCalled();
  });
  it.each([true, false])("removes SSH probe state only after confirmed teardown (%s)", async confirmed => {
    nativeProbe.mockImplementation(async input => {
      const registration = await input.transportOptions.controlPlaneRegistration({});
      await registration.release();
      if (confirmed) await input.onCleanupConfirmed();
      throw new Error("authentication failed");
    });
    expect((await testNativeRunnerAuthentication(sshContext, "codex", null)).status).toBe("fail");
    expect(sshExecute.mock.calls.some(([value]) => value.command === "rm")).toBe(confirmed);
    const root = nativeProbe.mock.calls[0][0].runtimeDirectory;
    if (confirmed) await expect(stat(root)).rejects.toThrow(); else expect((await stat(root)).isDirectory()).toBe(true);
  });
  it.each(["same-account", "another-account", "read-failure", "uncertain-close"] as const)("preserves managed SSH account refresh and confirmed cleanup (%s)", async mode => {
    const home = await mkdtemp(join(tmpdir(), "native-ssh-managed-account-"));
    const auth = (account: string, marker: string, age: number) => JSON.stringify({ tokens: { account_id: account, id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: new Date(Date.now() - age).toISOString() });
    try {
      await writeFile(join(home, "auth.json"), auth("qa-account", "old", 120_000), { mode: 0o600 });
      const refreshed = auth(mode === "another-account" ? "different-account" : "qa-account", "new", 60_000);
      sshExecute.mockImplementation(async input => ({ exitCode: input.args?.[2] === "paperclip-native-refresh" && mode === "read-failure" ? 1 : 0, timedOut: false,
        stdout: input.args?.[2] === "paperclip-native-refresh" ? Buffer.from(refreshed).toString("base64") : "", stderr: "" }));
      nativeProbe.mockImplementation(async input => {
        const registration = await input.transportOptions.controlPlaneRegistration({});
        await registration.release();
        const original = new Error("authentication failed in native SSH" + (mode === "uncertain-close" ? "; daemon teardown was not confirmed" : ""));
        try { await input.onCodexCredentialRefresh(posix.join(input.transportOptions.runnerFilesystemRoot, "codex-home", "auth.json")); }
        catch (error) { throw new AggregateError([original, error], original.message + "; " + (error as Error).message, { cause: original }); }
        if (mode !== "uncertain-close") await input.onCleanupConfirmed();
        throw original;
      });
      const result = await testNativeRunnerAuthentication({ ...sshContext, managedAiCredentialHome: home }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe("fail"); expect(result.checks[0].message).toContain("authentication failed in native SSH");
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens.access_token).toBe(mode === "same-account" || mode === "uncertain-close" ? "access-new" : "access-old");
      expect(sshExecute.mock.calls.some(([input]) => input.command === "rm")).toBe(mode === "same-account" || mode === "another-account");
      expect(JSON.stringify(result)).not.toContain("access-new");
      const read = sshExecute.mock.calls.find(([input]) => input.args?.[2] === "paperclip-native-refresh")![0];
      expect(read.command).toBe("sh"); expect(read.args[1]).toContain("head -c 65537"); expect(read.args[1]).toContain("test ! -L");
      expect(nativeProbe.mock.calls[0][0].transportOptions.sourceCodexHome).toBe(home);
      if (mode === "read-failure") expect(result.checks[0].message).toContain("refresh handoff unavailable");
      if (mode === "uncertain-close") expect(result.checks[0].message).toContain("teardown was not confirmed");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each(["codex", "opencode"] as const)("probes native %s in the selected remote pack with env-only credentials", async provider => {
    const model = provider === "codex" ? "gpt-6.1-sol" : "openrouter/example/model";
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify(receipt(provider, model)), stderr: "" });
    const result = await testNativeRunnerAuthentication({ ...context, config: { env: { OPENAI_API_KEY: "bound-account", ANTHROPIC_API_KEY: "", HOME: "/controller/home" } } }, provider, model);
    expect(result.status).toBe("pass");
    expect(execute).toHaveBeenCalledWith(expect.any(String), context.executionTarget, expect.stringContaining("probeNativeRunnerEnvironment"), expect.objectContaining({ cwd: "/workspace", env: { OPENAI_API_KEY: "bound-account", ANTHROPIC_API_KEY: "" }, timeoutSec: 110 }));
    expect(execute.mock.calls[0][2]).not.toContain("bound-account");
    const command = execute.mock.calls[0][2] as string;
    expect(command).toContain("manifest mismatch");
    expect(command).toContain("dist tree digest mismatch");
    expect(command).toContain("selected daemon digest mismatch");
    expect(command).not.toContain("command -v");
    expect(command).toContain("onCleanupConfirmed");
    expect(command).toContain("if (!codexCredentialRefreshPath)");
    expect(nativeProbe).not.toHaveBeenCalled();
    expect(remoteManifest).toHaveBeenCalledOnce();
    expect(bundledRunner).toHaveBeenCalledOnce();
    expect(configuredManifest).not.toHaveBeenCalled();
    expect(runnerBinding).toHaveBeenCalledWith("/release/linux-x64/paperclip-runnerd");
  });
  it.each(["codex", "opencode"] as const)("uses the standard Linux image artifacts for %s without an npm release manifest", async provider => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/opt/paperclip-runner/provider-pack");
    remoteManifest.mockImplementation(() => { throw new Error("no assembled npm manifest in the standard image"); });
    bundledRunner.mockImplementation(() => { throw new Error("no assembled npm daemon manifest in the standard image"); });
    const model = provider === "codex" ? null : "openrouter/example/model";
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify(receipt(provider, model ?? "actual-codex-model")), stderr: "" });
    expect((await testNativeRunnerAuthentication(context, provider, model)).status).toBe("pass");
    expect(configuredManifest).toHaveBeenCalledWith("/opt/paperclip-runner/provider-pack");
    expect(remoteManifest).not.toHaveBeenCalled();
    expect(bundledRunner).not.toHaveBeenCalled();
    expect(runnerBinding).toHaveBeenCalledWith(expect.stringMatching(/paperclip-runnerd$/));
  });
  it.each(["codex", "opencode"] as const)("preserves and redacts %s failures from combined sandbox output", async provider => {
    const model = provider === "codex" ? "gpt-6.1-sol" : "openrouter/example/model";
    const config = { env: { OPENAI_API_KEY: "selected-key", OPENROUTER_API_KEY: "selected-key",
      NATIVE_AUTH_JSON_SECRET: JSON.stringify({ tokens: { access_token: "selected-access-token", refresh_token: "selected-refresh-token" } }) } };
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: `Authentication failed for ${model}: selected-key selected-access-token selected-refresh-token\n${"diagnostic ".repeat(300)}`, stderr: "" });
    const result = await testNativeRunnerAuthentication({ ...context, config }, provider, model);
    expect(result).toMatchObject({ adapterType: "paperclip_runner", status: "fail", checks: [{ code: `${provider}_hello_probe_auth_required`, level: "error", message: expect.stringContaining(`Authentication failed for ${model}`) }] });
    expect(result.checks[0].message).toContain("[REDACTED]");
    expect(result.checks[0].message.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(result)).not.toMatch(/selected-key|selected-access-token|selected-refresh-token/);
    expect(result.checks[0].hint).toContain("Legacy runner is available explicitly in Advanced");
    expect(execute).toHaveBeenCalledOnce();
    expect(nativeProbe).not.toHaveBeenCalled();
  });
  it.each(["codex", "opencode"] as const)("keeps %s runtime/model failures distinct from authentication", async provider => {
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: "The requested model is unavailable", stderr: "" });
    const result = await testNativeRunnerAuthentication(context, provider, provider === "codex" ? "missing-model" : "provider/missing-model");
    expect(result).toMatchObject({ status: "fail", checks: [{ code: `${provider}_hello_probe_failed`, message: "The requested model is unavailable" }] });
  });
  it.each(["codex", "opencode"] as const)("prefers %s stderr over stdout when both streams are available", async provider => {
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: "Authentication failed in an unrelated diagnostic", stderr: "Provider pack prerequisite is missing: selected-key" });
    const result = await testNativeRunnerAuthentication({ ...context, config: { env: { OPENAI_API_KEY: "selected-key" } } }, provider, provider === "codex" ? null : "provider/model");
    expect(result).toMatchObject({ status: "fail", checks: [{ code: `${provider}_hello_probe_failed`, message: "Provider pack prerequisite is missing: [REDACTED]" }] });
  });
  it.each(["codex", "opencode"] as const)("retains %s actionable fallback for empty output and timeout precedence", async provider => {
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: " \n", stderr: " \n" });
    const model = provider === "codex" ? null : "provider/model";
    const empty = await testNativeRunnerAuthentication(context, provider, model);
    expect(empty).toMatchObject({ status: "fail", checks: [{ code: `${provider}_hello_probe_failed`, message: "The selected native runtime could not verify this account.", hint: expect.stringContaining("Legacy runner is available explicitly in Advanced") }] });
    execute.mockResolvedValue({ exitCode: 1, timedOut: true, stdout: "Authentication failed", stderr: "" });
    expect(await testNativeRunnerAuthentication(context, provider, model)).toMatchObject({ status: "fail", checks: [{ code: `${provider}_hello_probe_timeout`, message: "Native provider hello probe timed out." }] });
    expect(nativeProbe).not.toHaveBeenCalled();
  });
  it("preserves the explicitly selected qualified image daemon instead of resolving another one", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/opt/paperclip-runner/provider-pack");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "/image/exact-linux-daemon");
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify(receipt("codex", "actual-model")), stderr: "" });
    expect((await testNativeRunnerAuthentication(context, "codex", null)).status).toBe("pass");
    expect(runnerBinding).toHaveBeenCalledWith("/image/exact-linux-daemon");
  });
  it("fails before remote evaluation when the controller distribution has no qualified artifacts", async () => {
    remoteManifest.mockImplementation(() => { throw new Error("runner_remote_provider_artifact_incompatible: missing provider pack"); });
    const result = await testNativeRunnerAuthentication(context, "codex", null);
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "codex_hello_probe_failed", message: expect.stringContaining("missing provider pack") }] });
    expect(execute).not.toHaveBeenCalled();
    expect(nativeProbe).not.toHaveBeenCalled();
  });
  it.each([
    ["authentication failed: bound-account", "auth_required"], ["Native provider hello probe timed out.", "timeout"],
    ["Model is unavailable", "failed"], ["native executable is missing", "failed"], ["native provider returned no response", "failed"],
  ])("fails closed and redacts native failures (%s)", async (message, code) => {
    nativeProbe.mockRejectedValue(new Error(message));
    const result = await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: { env: { OPENAI_API_KEY: "bound-account" } } }, "codex", "gpt-6.1-sol");
    expect(result).toMatchObject({ status: "fail", checks: [{ code: `codex_hello_probe_${code}`, level: "error" }] });
    expect(JSON.stringify(result)).not.toContain("bound-account");
    expect(nativeProbe).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { helloProbePassed: undefined }, { effectiveModel: "another-model" }, { effectiveModel: null }, { effectiveModel: "" }, { provider: "opencode" }, { providerDriver: "codex_cli" },
  ])("rejects installation-only, legacy, or mismatched receipts", async override => {
    nativeProbe.mockResolvedValue({ ...receipt("codex", "gpt-6.1-sol"), ...override });
    expect((await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: {} }, "codex", "gpt-6.1-sol")).status).toBe("fail");
  });
  it("accepts an automatic Codex model only when the native provider observed a nonempty model", async () => {
    nativeProbe.mockResolvedValue(receipt("codex", "gpt-6.1-sol"));
    expect((await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: {} }, "codex", null)).status).toBe("pass");
    expect(nativeProbe.mock.calls[0][0].model).toBeNull();
    nativeProbe.mockResolvedValue(receipt("codex", null));
    expect((await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: {} }, "codex", null)).status).toBe("fail");
  });
  it.each([true, false])("removes failed local probe state only after confirmed teardown (%s)", async confirmed => {
    nativeProbe.mockImplementation(async input => {
      if (confirmed) await input.onCleanupConfirmed();
      throw new Error("authentication failed");
    });
    expect((await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: {} }, "codex", null)).status).toBe("fail");
    const root = nativeProbe.mock.calls[0][0].runtimeDirectory;
    if (confirmed) await expect(stat(root)).rejects.toThrow();
    else expect((await stat(root)).isDirectory()).toBe(true);
  });
  it("stages the bound Codex login and managed provider configuration on the selected target", async () => {
    const home = await mkdtemp(join(tmpdir(), "native-codex-selected-login-"));
    try {
      await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "bound-login-token" } }), { mode: 0o600 });
      await writeFile(join(home, "config.toml"), 'model_provider = "paperclip"\n', { mode: 0o600 });
      execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify(receipt("codex", "gpt-6.1-sol")), stderr: "" });
      expect((await testNativeRunnerAuthentication({ ...context, managedAiCredentialHome: home, config: { env: { CODEX_HOME: home } } }, "codex", "gpt-6.1-sol")).status).toBe("pass");
      const env = execute.mock.calls[0][3].env;
      expect(env._PAPERCLIP_NATIVE_SETUP_CODEX_AUTH_JSON_SECRET).toContain("bound-login-token");
      expect(env._PAPERCLIP_NATIVE_SETUP_CODEX_CONFIG_TOML_SECRET).toContain('model_provider = "paperclip"');
      expect(env.CODEX_HOME).toBeUndefined();
      expect(execute.mock.calls[0][2]).not.toContain("bound-login-token");
      expect(execute.mock.calls[0][2]).not.toContain(home);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each(["same-account", "another-account", "read-failure", "uncertain-close"] as const)("retains the native failure while applying the existing Codex refresh rule (%s)", async mode => {
    const home = await mkdtemp(join(tmpdir(), "native-codex-failed-refresh-"));
    const auth = (account: string, marker: string, age: number) => JSON.stringify({ tokens: { account_id: account, id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: new Date(Date.now() - age).toISOString() });
    const initial = auth("qa-account", "old", 120_000);
    const refreshed = auth(mode === "another-account" ? "unrelated-account" : "qa-account", "new", 60_000);
    try {
      await writeFile(join(home, "auth.json"), initial, { mode: 0o600 });
      execute.mockResolvedValueOnce({ exitCode: 0, timedOut: false, stderr: "", stdout: JSON.stringify({ nativeProbeError: "authentication failed in the selected native provider" + (mode === "uncertain-close" ? "; native provider teardown was not confirmed" : ""), cleanupConfirmed: mode !== "uncertain-close", runtimeDirectory: "/tmp/paperclip-native-setup-QA123", codexCredentialRefreshPath: "/tmp/paperclip-native-setup-QA123/codex-home/auth.json" }) });
      execute.mockResolvedValueOnce({ exitCode: mode === "read-failure" ? 1 : 0, timedOut: false, stderr: "", stdout: Buffer.from(refreshed).toString("base64") });
      execute.mockResolvedValueOnce({ exitCode: 0, timedOut: false, stderr: "", stdout: "" });
      const result = await testNativeRunnerAuthentication({ ...context, managedAiCredentialHome: home }, "codex", "gpt-6.1-sol");
      expect(result).toMatchObject({ status: "fail", checks: [{ code: "codex_hello_probe_auth_required", message: expect.stringContaining("authentication failed in the selected native provider") }] });
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens.access_token).toBe(mode === "same-account" || mode === "uncertain-close" ? "access-new" : "access-old");
      if (mode === "read-failure") expect(result.checks[0].message).toContain("credential refresh handoff unavailable");
      expect(JSON.stringify(result)).not.toContain("access-new");
      expect(execute.mock.calls[1][3].env).toEqual({});
      if (mode === "uncertain-close") {
        expect(result.checks[0].message).toContain("teardown was not confirmed");
        expect(execute).toHaveBeenCalledTimes(2);
        expect(execute.mock.calls.some(call => String(call[2]).startsWith("rm -rf"))).toBe(false);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe("selected native account verification", () => {
  const receipt = { effectiveModel: "claude-sonnet-5", commandDigest: QUALIFIED_ACPX_PROFILES.claude.commandDigest, helloProbePassed: true as const };
  const localContext = { companyId: "company", adapterType: "paperclip_runner", config: { env: { CLAUDE_CODE_OAUTH_TOKEN: "bound-subscription-token" } } };
  beforeEach(() => { execute.mockReset(); probe.mockReset().mockResolvedValue(receipt); });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const [input] of probe.mock.calls) if (input.runtimeDirectory) await rm(input.runtimeDirectory, { recursive: true, force: true });
  });

  it("uses the production native host, a private workspace, and only the bound account", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-account-must-not-be-used");
    probe.mockImplementation(async input => {
      expect((await stat(input.runtimeDirectory)).mode & 0o777).toBe(0o700);
      return receipt;
    });
    const result = await testNativeAcpxAuthentication(localContext, "claude", "claude-sonnet-5");
    expect(result.status).toBe("pass");
    expect(result.checks).toEqual([expect.objectContaining({ code: "claude_hello_probe_passed" })]);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ agent: "claude", model: "claude-sonnet-5", hello: true, timeoutMs: 45_000, environment: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "bound-subscription-token" }) }));
    expect(probe.mock.calls[0][0].environment.ANTHROPIC_API_KEY).toBeUndefined();
    await expect(stat(probe.mock.calls[0][0].runtimeDirectory)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("sends credentials as environment data on the selected target, never in command text", async () => {
    execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: JSON.stringify(receipt), stderr: "" });
    const result = await testNativeAcpxAuthentication({ ...context, config: localContext.config }, "claude", "claude-sonnet-5");
    expect(result.status).toBe("pass");
    expect(execute).toHaveBeenCalledWith(expect.any(String), context.executionTarget, expect.stringContaining("probeQualifiedAcpxEnvironment"), expect.objectContaining({ cwd: "/workspace", env: expect.objectContaining({ CLAUDE_CODE_OAUTH_TOKEN: "bound-subscription-token" }), timeoutSec: 110 }));
    expect(execute.mock.calls[0][2]).not.toContain("bound-subscription-token");
  });

  const remoteCredentials = [["claude", "CLAUDE_CODE_OAUTH_TOKEN", "claude-sonnet-5"], ["grok", "XAI_API_KEY", "grok-4.7"], ["cursor", "CURSOR_AUTH_TOKEN", "cursor-model"]] as const;
  it.each(remoteCredentials)("preserves and redacts %s failures from combined sandbox output", async (agent, key, model) => {
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: `Authentication failed for ${model}: bound-subscription-token\n${"diagnostic ".repeat(300)}`, stderr: "" });
    const result = await testNativeAcpxAuthentication({ ...context, config: { env: { [key]: "bound-subscription-token" } } }, agent, model);
    expect(result).toMatchObject({ adapterType: "paperclip_runner", status: "fail", checks: [{ code: `${agent}_hello_probe_auth_required`, level: "error", message: expect.stringContaining(`Authentication failed for ${model}`) }] });
    expect(result.checks[0].message).toContain("[REDACTED]");
    expect(result.checks[0].message.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(result)).not.toContain("bound-subscription-token");
    expect(result.checks[0].hint).toContain("Legacy runner is available explicitly in Advanced");
    expect(execute).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
  });
  it.each(remoteCredentials)("keeps %s runtime/model failures distinct from authentication", async (agent, key, model) => {
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: "The requested model is unavailable", stderr: "" });
    const result = await testNativeAcpxAuthentication({ ...context, config: { env: { [key]: "selected-account" } } }, agent, model);
    expect(result).toMatchObject({ status: "fail", checks: [{ code: `${agent}_hello_probe_failed`, message: "The requested model is unavailable" }] });
  });
  it.each(remoteCredentials)("prefers %s stderr over stdout when both streams are available", async (agent, key, model) => {
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: "Authentication failed in an unrelated diagnostic", stderr: "Provider pack prerequisite is missing: selected-account" });
    const result = await testNativeAcpxAuthentication({ ...context, config: { env: { [key]: "selected-account" } } }, agent, model);
    expect(result).toMatchObject({ status: "fail", checks: [{ code: `${agent}_hello_probe_failed`, message: "Provider pack prerequisite is missing: [REDACTED]" }] });
  });
  it.each(remoteCredentials)("retains %s actionable fallback for empty output and timeout precedence", async (agent, key, model) => {
    const selectedContext = { ...context, config: { env: { [key]: "selected-account" } } };
    execute.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: " \n", stderr: " \n" });
    const empty = await testNativeAcpxAuthentication(selectedContext, agent, model);
    expect(empty).toMatchObject({ status: "fail", checks: [{ code: `${agent}_hello_probe_failed`, message: "The selected native runtime could not verify this account.", hint: expect.stringContaining("Legacy runner is available explicitly in Advanced") }] });
    execute.mockResolvedValue({ exitCode: 1, timedOut: true, stdout: "Authentication failed", stderr: "" });
    expect(await testNativeAcpxAuthentication(selectedContext, agent, model)).toMatchObject({ status: "fail", checks: [{ code: `${agent}_hello_probe_timeout`, message: "Native provider hello probe timed out." }] });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("Authentication failed: bound-subscription-token"), "claude_hello_probe_auth_required"],
    [new Error("Native provider hello probe timed out."), "claude_hello_probe_timeout"],
    [new Error("Model is unavailable"), "claude_hello_probe_failed"],
  ])("preserves actionable failure without another runner and redacts bound credentials", async (error, code) => {
    probe.mockRejectedValue(error);
    const result = await testNativeAcpxAuthentication(localContext, "claude", "claude-sonnet-5");
    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("bound-subscription-token");
    expect(result.checks[0].hint).toContain("Legacy runner");
    expect(probe).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([{ ...receipt, helloProbePassed: undefined }, { ...receipt, effectiveModel: "other-model" }, { ...receipt, commandDigest: "different-runtime" }])("rejects installation-only or mismatched native receipts", async value => {
    probe.mockResolvedValue(value);
    expect((await testNativeAcpxAuthentication(localContext, "claude", "claude-sonnet-5")).status).toBe("fail");
  });

  it.each([["cursor", "CURSOR_AUTH_TOKEN", "cursor-model"], ["grok", "XAI_API_KEY", "grok-4.7"]] as const)("verifies the explicitly bound %s credential and model through the same native host", async (agent, key, model) => {
    vi.stubEnv(key, "ambient-account");
    probe.mockResolvedValue({ ...receipt, effectiveModel: model, commandDigest: QUALIFIED_ACPX_PROFILES[agent].commandDigest });
    const result = await testNativeAcpxAuthentication({ ...localContext, config: { env: { [key]: "selected-account" } } }, agent, model);
    expect(result.status, JSON.stringify(result)).toBe("pass");
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ agent, model, hello: true, environment: expect.objectContaining({ [key]: "selected-account" }) }));
    expect(result.checks[0].code).toBe(`${agent}_hello_probe_passed`);
  });

  it("accepts Cursor's normalized hello identity only after verifying its advertised full model", async () => {
    const model = "gpt-5.6-sol", selector = `${model}[context=272k,reasoning=medium,fast=false]`;
    let currentModelId = "default";
    const setModel = vi.fn(async selected => { currentModelId = selected; });
    probe.mockImplementation(async input => {
      const verified = await requireVerifiedAcpxModel({
        getStatus: async () => ({ models: { currentModelId, availableModelIds: [selector] } }), setModel,
      }, resolveQualifiedAcpxProfile(input.agent, input.model));
      return { effectiveModel: verified.models!.currentModelId, commandDigest: QUALIFIED_ACPX_PROFILES.cursor.commandDigest, helloProbePassed: true };
    });
    const selectedContext = { ...localContext, config: { env: { CURSOR_AUTH_TOKEN: "selected-account" } } };
    expect((await testNativeAcpxAuthentication(selectedContext, "cursor", model)).status).toBe("pass");
    expect(setModel).toHaveBeenCalledExactlyOnceWith(selector);
    // A custom full ID is still passed unchanged to the provider and may fail;
    // it never borrows the successful base-model selection above.
    setModel.mockRejectedValue(new Error("Model is not available for this account"));
    const rejected = await testNativeAcpxAuthentication(selectedContext, "cursor", "custom/model[context=272k]");
    expect(rejected.status).toBe("fail");
    expect(rejected.checks[0].code).toBe("cursor_hello_probe_failed");
    expect(setModel).toHaveBeenLastCalledWith("custom/model[context=272k]");
  });

  const grokReceipt = { ...receipt, effectiveModel: "grok-4.7", commandDigest: QUALIFIED_ACPX_PROFILES.grok.commandDigest };
  const grokAuth = (marker: string, expiresAt: string) => JSON.stringify({ "https://auth.x.ai::11111111-1111-1111-1111-111111111111": { key: `key-${marker}`, refresh_token: `refresh-${marker}`, expires_at: expiresAt } });
  const olderExpiry = () => new Date(Date.now() + 60_000).toISOString();
  const newerExpiry = () => new Date(Date.now() + 120_000).toISOString();
  it("stages only the server-owned Grok login and preserves a newer same-account refresh before cleanup", async () => {
    const home = await mkdtemp(join(tmpdir(), "grok-setup-connection-test-"));
    const oldAuth = grokAuth("old", olderExpiry());
    const newAuth = grokAuth("new", newerExpiry());
    try {
      await writeFile(join(home, "auth.json"), oldAuth, { mode: 0o600 });
      vi.stubEnv("XAI_API_KEY", "ambient-key-must-not-be-used");
      probe.mockImplementation(async input => {
        expect(input.environment.PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET).toBe(oldAuth);
        expect(input.environment.XAI_API_KEY).toBeUndefined();
        expect(input.environment.GROK_HOME).toBeUndefined();
        const refreshed = join(await realpath(input.runtimeDirectory), "refresh.json");
        await writeFile(refreshed, newAuth, { mode: 0o600 });
        await input.onGrokCredentialRefresh(refreshed);
        return grokReceipt;
      });
      const result = await testNativeAcpxAuthentication({ ...localContext, managedAiCredentialHome: home, config: { env: { GROK_HOME: "/untrusted/home" } } }, "grok", "grok-4.7");
      expect(result.status, JSON.stringify(result)).toBe("pass");
      expect(await readFile(join(home, "auth.json"), "utf8")).toBe(newAuth);
      expect(JSON.stringify(result)).not.toContain("key-new");
      await expect(stat(probe.mock.calls[0][0].runtimeDirectory)).rejects.toThrow();
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each([false, true])("remote Grok preserves refresh on the controller before reporting readiness (failed turn: %s)", async failed => {
    const home = await mkdtemp(join(tmpdir(), "grok-setup-remote-test-"));
    const runtimeDirectory = "/tmp/paperclip-native-setup-QA1";
    const grokCredentialRefreshPath = posix.join(runtimeDirectory, "acpx", acpxRuntimeSessionDirectoryName("environment-probe"), "grok-home", "auth-refresh.json");
    const newAuth = grokAuth("new", newerExpiry());
    try {
      await writeFile(join(home, "auth.json"), grokAuth("old", olderExpiry()), { mode: 0o600 });
      execute.mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ ...(failed ? { nativeProbeError: "Provider rejected turn" } : grokReceipt), cleanupConfirmed: true, runtimeDirectory, grokCredentialRefreshPath }), stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: Buffer.from(newAuth).toString("base64"), stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
      const result = await testNativeAcpxAuthentication({ ...context, managedAiCredentialHome: home, config: { env: { HOME: "/controller/home", GROK_HOME: "/untrusted/home" } } }, "grok", "grok-4.7");
      expect(result.status, JSON.stringify(result)).toBe(failed ? "fail" : "pass");
      expect(await readFile(join(home, "auth.json"), "utf8")).toBe(newAuth);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls[0][3].env.HOME).toBeUndefined();
      expect(execute.mock.calls[0][3].env.PATH).toBeUndefined();
      expect(execute.mock.calls[0][2]).not.toContain("key-old");
      expect(execute.mock.calls[2][2]).toContain(runtimeDirectory);
      expect(JSON.stringify(result)).not.toContain("key-new");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

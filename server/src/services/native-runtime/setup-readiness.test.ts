import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
const { execute, nativeProbe, selectedRunner, sshExecute, sshRunner, nativeArtifacts, remoteLauncher, registerPrp, ingressConnect } = vi.hoisted(() => ({ execute: vi.fn(), nativeProbe: vi.fn(), selectedRunner: vi.fn(), sshExecute: vi.fn(), sshRunner: vi.fn(), nativeArtifacts: vi.fn(), remoteLauncher: vi.fn(), registerPrp: vi.fn(), ingressConnect: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetShellCommand: execute }));
vi.mock("./native-ssh-command-runner.js", () => ({ createNativeSshCommandRunner: sshRunner }));
vi.mock("../../realtime/runner-prp-ws.js", () => ({ registerRunnerPrpAuthority: registerPrp }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingressConnect }));
vi.mock("./native-codex-runner.js", () => ({ resolvePaperclipRunnerBinary: selectedRunner }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({ ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(), probeNativeRunnerEnvironment: nativeProbe }));
vi.mock("./native-session-executor.js", async original => ({ ...await original<typeof import("./native-session-executor.js")>(), createRemoteNativeArtifactPreparation: nativeArtifacts, createRemoteRunnerProcessLauncher: remoteLauncher }));
import { testNativeRunnerAuthentication } from "./setup-readiness.js";
const context = {
  companyId: "company", adapterType: "paperclip_runner", config: {},
  executionTarget: { kind: "remote" as const, transport: "sandbox" as const, providerKey: "test", remoteCwd: "/workspace", runner: { execute: vi.fn() } },
};
describe("Codex selected native account verification", () => {
  const receipt = (provider: "codex", model: string | null) => ({ provider, effectiveModel: model, providerDriver: "codex_app_server", helloProbePassed: true, cleanupConfirmed: true });
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
    selectedRunner.mockReset().mockReturnValue("/fixture/bin/paperclip-runnerd");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const [input] of nativeProbe.mock.calls) if (input.runtimeDirectory) await rm(input.runtimeDirectory, { recursive: true, force: true });
  });
  it.each([["codex", "gpt-6.1-sol", "OPENAI_API_KEY"]] as const)("requires the native %s host and only the selected credential", async (provider, model, key) => {
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
  it.each(["same-account", "another-account", "bound-key", "invalid-handoff"] as const)("preserves the authorized unmanaged login refresh before local cleanup (%s)", async mode => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-local-login-")));
    const auth = (account: string, marker: string, age: number) => JSON.stringify({ tokens: { account_id: account, id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: new Date(Date.now() - age).toISOString() });
    const store = join(home, "account.json");
    try {
      await writeFile(store, auth("qa-account", "old", 120_000), { mode: 0o600 });
      // Existing per-agent homes can point at their authorized shared account.
      await symlink(store, join(home, "auth.json"));
      nativeProbe.mockImplementation(async input => {
        const privateHome = join(input.runtimeDirectory, "codex-home");
        await mkdir(privateHome, { mode: 0o700 });
        const filename = join(privateHome, "auth.json");
        await writeFile(filename, auth(mode === "another-account" ? "other-account" : "qa-account", "new", 60_000), { mode: 0o600 });
        if (mode === "bound-key") expect(input.onCodexCredentialRefresh).toBeUndefined();
        else await input.onCodexCredentialRefresh(mode === "invalid-handoff" ? store : filename);
        await input.onCleanupConfirmed();
        return receipt("codex", "gpt-6.1-sol");
      });
      const result = await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: { env: { CODEX_HOME: home, ...(mode === "bound-key" ? { OPENAI_API_KEY: "selected-key" } : {}) } } }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe(mode === "invalid-handoff" ? "fail" : "pass");
      expect(JSON.parse(await readFile(store, "utf8")).tokens.access_token).toBe(mode === "same-account" ? "access-new" : "access-old");
      expect((await stat(store)).mode & 0o777).toBe(0o600);
      expect(await realpath(join(home, "auth.json"))).toBe(store);
      expect(JSON.stringify(result)).not.toContain("access-new");
      if (mode !== "invalid-handoff") await expect(stat(nativeProbe.mock.calls[0][0].runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  const sshContext = { companyId: "company", adapterType: "paperclip_runner", config: {}, executionTarget: {
    kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/qa-workspace", spec: { host: "qa-host", username: "qa-user", port: 22, remoteCwd: "/qa-workspace", remoteWorkspacePath: "/qa-workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true },
  } };
  it("uses task staging and the company-scoped native SSH transport without a provider pack", async () => {
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
    expect(execute).not.toHaveBeenCalled();
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
  it.each([
    ["authentication failed: bound-account", "auth_required"], ["Native provider hello probe timed out.", "timeout"],
    ["Model is unavailable", "failed"], ["native executable is missing", "failed"], ["native provider returned no response", "failed"],
  ])("fails closed and redacts native failures (%s)", async (message, code) => {
    nativeProbe.mockRejectedValue(new Error(message));
    const result = await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: { env: { OPENAI_API_KEY: "bound-account" } } }, "codex", "gpt-6.1-sol");
    expect(result.status).toBe("fail");
    expect(result.checks[0]).toMatchObject({ code: `codex_hello_probe_${code}`, level: "error" });
    expect(result.checks.some(check => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(code === "auth_required");
    expect(JSON.stringify(result)).not.toContain("bound-account");
    expect(nativeProbe).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ["authentication required: selected-account", true],
    ["Model is unavailable", false],
    ["native executable is missing", false],
  ])("projects the canonical sandbox login check only for authentication failures (%s)", async (message, authentication) => {
    nativeProbe.mockRejectedValue(new Error(message));
    const result = await testNativeRunnerAuthentication(context, "codex", "gpt-6.1-sol");
    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe(`codex_hello_probe_${authentication ? "auth_required" : "failed"}`);
    expect(result.checks.some(check => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(authentication);
    if (authentication) expect(result.checks).toContainEqual(expect.objectContaining({ code: ADAPTER_AUTH_MISSING_CHECK_CODE, level: "error" }));
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
    nativeProbe.mockResolvedValue(receipt("codex", "unknown"));
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
  it("uses the same preparation and controller PRP for a sandbox, without a guest provider pack", async () => {
    nativeProbe.mockImplementation(async input => {
      const registration = await input.transportOptions.controlPlaneRegistration({});
      expect(registration.connection.mode).toBe("connect");
      await registration.release(); await input.onCleanupConfirmed();
      return receipt("codex", "gpt-6.1-sol");
    });
    const target = { ...context.executionTarget, runner: { execute: sshExecute } };
    expect((await testNativeRunnerAuthentication({ ...context, executionTarget: target }, "codex", "gpt-6.1-sol")).status).toBe("pass");
    expect(sshRunner).not.toHaveBeenCalled();
    expect(nativeArtifacts).toHaveBeenCalledWith(expect.objectContaining({ target, runner: target.runner }));
    expect(nativeArtifacts.mock.results[0].value.prepare).toHaveBeenCalledWith("dial_wss");
    expect(execute).not.toHaveBeenCalled();
  });
  it("prepares listener artifacts before acquiring sandbox ingress and owns its release", async () => {
    const order: string[] = [];
    const close = vi.fn();
    const endpoint = { kind: "authenticated_websocket" as const, websocketUrl: "wss://ingress.test", secretHeaders: [], generation: "generation", refresh: vi.fn(), close };
    const getRunnerIngressEndpoint = vi.fn(async () => { order.push("ingress"); return endpoint; });
    nativeArtifacts.mockReturnValue({ prepare: vi.fn(async mode => { expect(mode).toBe("listen_ws"); order.push("artifacts"); }) });
    const connectionClose = vi.fn();
    ingressConnect.mockImplementation(() => { order.push("connect"); return { ready: Promise.resolve(), close: connectionClose }; });
    nativeProbe.mockImplementation(async input => {
      const registration = await input.transportOptions.controlPlaneRegistration({});
      expect(registration.connection.mode).toBe("listen");
      remoteLauncher.mock.calls[0][0].onRunnerProcessSpawned();
      await registration.activate(); await registration.ready(); await registration.release();
      await input.onCleanupConfirmed(); return receipt("codex", "gpt-6.1-sol");
    });
    const target = { ...context.executionTarget, providerKey: "daytona", runner: { execute: sshExecute }, leaseId: "lease", effectiveCapabilities: { reusableLeases: false, nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false, independentControlCommands: true, incrementalSessionOutput: false, concurrentSyncOperations: false, duplexCommandStream: false, runnerWebSocketIngress: true }, getRunnerIngressEndpoint };
    expect((await testNativeRunnerAuthentication({ ...context, executionTarget: target }, "codex", "gpt-6.1-sol")).status).toBe("pass");
    expect(order).toEqual(["artifacts", "ingress", "connect"]);
    expect(connectionClose).toHaveBeenCalledOnce(); expect(registerPrp).not.toHaveBeenCalled();
  });
});

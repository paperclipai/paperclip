import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";
import * as localCredentialFile from "../local-ai-credential-file.js";
import * as codexCredentials from "@paperclipai/adapter-codex-local/server";
const { prepareIsolatedCodexHome } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/runtime-context-materializer.ts", import.meta.url).href);
const { execute, nativeProbe, selectedRunner, selectedRemoteRunner, sshExecute, sshRunner, nativeArtifacts, remoteLauncher, registerPrp, ingressConnect } = vi.hoisted(() => ({ execute: vi.fn(), nativeProbe: vi.fn(), selectedRunner: vi.fn(), selectedRemoteRunner: vi.fn(), sshExecute: vi.fn(), sshRunner: vi.fn(), nativeArtifacts: vi.fn(), remoteLauncher: vi.fn(), registerPrp: vi.fn(), ingressConnect: vi.fn() }));
const nativeProbeRuntimeDirectories = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async original => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return { ...filesystem, mkdtemp: async (...args: Parameters<typeof filesystem.mkdtemp>) => {
    const directory = await filesystem.mkdtemp(...args);
    if (typeof args[0] === "string" && args[0].endsWith("paperclip-native-setup-") && typeof directory === "string") nativeProbeRuntimeDirectories.push(directory);
    return directory;
  } };
});
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetShellCommand: execute }));
vi.mock("./native-ssh-command-runner.js", () => ({ createNativeSshCommandRunner: sshRunner }));
vi.mock("../../realtime/runner-prp-ws.js", () => ({ registerRunnerPrpAuthority: registerPrp }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingressConnect }));
vi.mock("./native-codex-runner.js", () => ({ resolvePaperclipRunnerBinary: selectedRunner, resolveRemotePaperclipRunnerBinary: selectedRemoteRunner }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({ ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(), probeNativeRunnerEnvironment: nativeProbe }));
vi.mock("./native-session-executor.js", async original => ({ ...await original<typeof import("./native-session-executor.js")>(), createRemoteNativeArtifactPreparation: nativeArtifacts, createRemoteRunnerProcessLauncher: remoteLauncher }));
import { testNativeRunnerAuthentication } from "./setup-readiness.js";
const context = {
  companyId: "company", adapterType: "paperclip_runner", config: { externallySandboxed: false, env: { PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "false" } },
  executionTarget: { kind: "remote" as const, transport: "sandbox" as const, providerKey: "test", remoteCwd: "/workspace", runner: { execute: vi.fn() } },
};
describe("Codex selected native account verification", () => {
  const receipt = (provider: "codex", model: string | null) => ({ provider, effectiveModel: model, providerDriver: "codex_app_server", helloProbePassed: true, cleanupConfirmed: true });
  beforeEach(() => {
    execute.mockReset(); nativeProbe.mockReset(); nativeProbeRuntimeDirectories.splice(0);
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
    selectedRemoteRunner.mockReset().mockResolvedValue("/fixture/bin/paperclip-runnerd");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "");
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const root of nativeProbeRuntimeDirectories) await rm(root, { recursive: true, force: true });
  });
  it.each([["codex", "gpt-6.1-sol", "OPENAI_API_KEY"]] as const)("requires the native %s host and only the selected credential", async (provider, model, key) => {
    vi.stubEnv(key, "ambient-account");
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-anthropic");
    nativeProbe.mockImplementation(async input => { await input.onCleanupConfirmed(); return receipt(provider, model); });
    const result = await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", config: { externallySandboxed: true, env: { [key]: "bound-account", PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "true" }, modelReasoningEffort: "low" } }, provider, model);
    expect(result.status).toBe("pass");
    const input = nativeProbe.mock.calls[0][0];
    expect(input).toMatchObject({ provider, model, timeoutMs: 45_000, environment: { [key]: "bound-account" } });
    expect(input.transportOptions.runnerBinary).toBe("/fixture/bin/paperclip-runnerd");
    expect(input.transportOptions.externallySandboxed).toBe(false);
    expect(selectedRunner).toHaveBeenCalledOnce();
    expect(input.environment.ANTHROPIC_API_KEY).toBeUndefined();
    if (provider === "codex") expect(input.reasoningEffort).toBe("low");
    else expect(input.reasoningEffort).toBeUndefined();
    await expect(stat(input.runtimeDirectory)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects a missing local daemon before creating private credential staging", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-preflight-daemon-")));
    const auth = '{"tokens":{"account_id":"fixture-account","access_token":"fixture-access"}}';
    const readCredential = vi.spyOn(localCredentialFile, "readLocalAiCredentialFile");
    try {
      await writeFile(join(home, "account-store.json"), auth, { mode: 0o600 });
      await symlink(join(home, "account-store.json"), join(home, "auth.json"));
      selectedRunner.mockImplementation(() => { throw new Error("native executable is missing"); });
      const result = await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", managedAiCredentialHome: home, config: {} }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe("fail");
      expect(result.checks[0].message).toBe("native executable is missing");
      expect(readCredential).toHaveBeenCalledOnce();
      expect(nativeProbeRuntimeDirectories).toEqual([]);
      expect(nativeProbe).not.toHaveBeenCalled();
      expect(await readFile(join(home, "account-store.json"), "utf8")).toBe(auth);
      expect(await readlink(join(home, "auth.json"))).toBe(join(home, "account-store.json"));
      expect((await readdir(home)).sort()).toEqual(["account-store.json", "auth.json"]);
    } finally { readCredential.mockRestore(); await rm(home, { recursive: true, force: true }); }
  });
  it.each(["local", "remote"])("cleans its own private root when %s credential staging fails before probe handoff", async transport => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-preflight-staging-")));
    const auth = '{"tokens":{"account_id":"fixture-account","access_token":"fixture-access"}}';
    try {
      await writeFile(join(home, "account-store.json"), auth, { mode: 0o600 });
      await symlink(join(home, "account-store.json"), join(home, "auth.json"));
      await writeFile(join(home, "config.toml"), "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
      const selectedContext = transport === "remote" ? sshContext : { companyId: "company", adapterType: "paperclip_runner", config: {} };
      const result = await testNativeRunnerAuthentication({ ...selectedContext, managedAiCredentialHome: home }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe("fail");
      expect(result.checks[0].message).toContain("configuration exceeds its size limit");
      expect(nativeProbe).not.toHaveBeenCalled();
      expect(sshExecute).not.toHaveBeenCalled();
      expect(nativeProbeRuntimeDirectories).toHaveLength(1);
      await expect(stat(nativeProbeRuntimeDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(home, "account-store.json"), "utf8")).toBe(auth);
      expect((await stat(join(home, "config.toml"))).size).toBe(1024 * 1024 + 1);
      expect(await readlink(join(home, "auth.json"))).toBe(join(home, "account-store.json"));
    } finally { await rm(home, { recursive: true, force: true }); }
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
  it.each(["same-account", "another-account", "bound-key", "invalid-handoff"] as const)("preserves the server-selected login refresh before local cleanup (%s)", async mode => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-local-login-")));
    const auth = (account: string, marker: string, age: number) => JSON.stringify({ tokens: { account_id: account, id_token: `id-${marker}`, access_token: `access-${marker}`, refresh_token: `refresh-${marker}` }, last_refresh: new Date(Date.now() - age).toISOString() });
    const store = join(home, "account.json");
    try {
      await writeFile(store, auth("qa-account", "old", 120_000), { mode: 0o600 });
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
      const result = await testNativeRunnerAuthentication({ companyId: "company", adapterType: "paperclip_runner", managedAiCredentialHome: home, config: { env: { CODEX_HOME: home, ...(mode === "bound-key" ? { OPENAI_API_KEY: "selected-key" } : {}) } } }, "codex", "gpt-6.1-sol");
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
  it.each(["local", "remote"].flatMap(transport => ["configured", "operator"].flatMap(source => [false, true].map(linked => ({ transport, source, linked })))))
  ("matches actual task auth seeding before $transport setup (source=$source, linked=$linked)", async ({ transport, source, linked }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-unbound-auth-")));
    const auth = '{"tokens":{"account_id":"fixture-unbound-account","access_token":"fixture-unbound-access","refresh_token":"fixture-unbound-refresh","id_token":"fixture-unbound-id"}}';
    try {
      const stored = join(home, linked ? "account-store.json" : "auth.json");
      await writeFile(stored, auth, { mode: 0o600 });
      if (linked) await symlink(stored, join(home, "auth.json"));
      const taskHome = join(home, "actual-task-home");
      await prepareIsolatedCodexHome({ context: null, codexHome: taskHome, sourceCodexHome: home });
      const taskAuth = await readFile(join(taskHome, "auth.json"), "utf8").catch(() => null);
      expect(taskAuth).toBe(linked ? null : auth);
      vi.stubEnv("CODEX_HOME", source === "operator" ? home : "");
      nativeProbe.mockImplementation(async input => {
        const probeHome = join(input.runtimeDirectory, "codex-home");
        await prepareIsolatedCodexHome({ context: null, codexHome: probeHome, sourceCodexHome: input.transportOptions.sourceCodexHome });
        expect(await readFile(join(probeHome, "auth.json"), "utf8")).toBe(auth);
        await input.onCleanupConfirmed();
        return receipt("codex", "gpt-6.1-sol");
      });
      const testContext = transport === "remote" ? sshContext : { companyId: "company", adapterType: "paperclip_runner", config: {} };
      const result = await testNativeRunnerAuthentication({ ...testContext, config: {
        managedAiCredentialHome: home,
        env: source === "configured" ? { CODEX_HOME: home } : {},
      } }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe(linked ? "fail" : "pass");
      if (linked) {
        expect(nativeProbe).not.toHaveBeenCalled();
        expect(sshExecute).not.toHaveBeenCalled();
        expect(result.checks[0].message).toContain(source === "configured" ? "env.CODEX_HOME" : "operator CODEX_HOME");
        expect(result.checks[0].message).toContain("Legacy runner");
        expect(result.checks[0].message).toContain("managed Codex Connection");
      } else expect(nativeProbe).toHaveBeenCalledOnce();
      expect(await readFile(stored, "utf8")).toBe(auth);
      expect(JSON.stringify(result)).not.toContain("fixture-unbound-access");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each(["local", "remote"].flatMap(transport => ["OPENAI_API_KEY", "CODEX_API_KEY"].flatMap(key => ["valid", "dangling", "invalid-store", "probe-error"].map(authState => ({ transport, key, authState })))))
  ("keeps the configured $key task credential authoritative over $authState linked auth during $transport setup", async ({ transport, key, authState }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-key-linked-auth-")));
    const auth = '{"tokens":{"account_id":"unused-subscription","access_token":"unused-subscription-access"}}';
    const stored = join(home, "account-store.json");
    const readCredential = vi.spyOn(localCredentialFile, "readLocalAiCredentialFile");
    const copyBack = vi.spyOn(codexCredentials, "copyBackCodexAuth");
    try {
      if (authState === "valid" || authState === "probe-error") await writeFile(stored, auth, { mode: 0o600 });
      else if (authState === "invalid-store") await mkdir(stored, { mode: 0o700 });
      await symlink(stored, join(home, "auth.json"));
      const taskHome = join(home, "actual-key-task-home");
      await prepareIsolatedCodexHome({ context: null, codexHome: taskHome, sourceCodexHome: home, apiKey: "configured-fixture-key" });
      expect(JSON.parse(await readFile(join(taskHome, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "configured-fixture-key" });
      nativeProbe.mockImplementation(async input => {
        expect(input.onCodexCredentialRefresh).toBeUndefined();
        expect(input.transportOptions.sourceCodexHome).toBe(home);
        const probeHome = join(input.runtimeDirectory, "codex-home");
        await prepareIsolatedCodexHome({ context: null, codexHome: probeHome, sourceCodexHome: input.transportOptions.sourceCodexHome,
          apiKey: input.environment.CODEX_API_KEY ?? input.environment.OPENAI_API_KEY });
        expect(JSON.parse(await readFile(join(probeHome, "auth.json"), "utf8"))).toEqual({ OPENAI_API_KEY: "configured-fixture-key" });
        await input.onCleanupConfirmed();
        if (authState === "probe-error") throw new Error("authentication failed: configured-fixture-key");
        return receipt("codex", "gpt-6.1-sol");
      });
      const testContext = transport === "remote" ? sshContext : { companyId: "company", adapterType: "paperclip_runner", config: {} };
      const result = await testNativeRunnerAuthentication({ ...testContext, config: { env: { CODEX_HOME: home, [key]: "configured-fixture-key" } } }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe(authState === "probe-error" ? "fail" : "pass");
      if (authState === "probe-error") expect(result.checks[0]).toMatchObject({ code: "codex_hello_probe_auth_required", message: "authentication failed: [REDACTED]" });
      expect(nativeProbe).toHaveBeenCalledOnce();
      expect(readCredential).not.toHaveBeenCalled();
      expect(copyBack).not.toHaveBeenCalled();
      expect((await lstat(join(home, "auth.json"))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(home, "auth.json"))).toBe(stored);
      if (authState === "valid" || authState === "probe-error") expect(await readFile(stored, "utf8")).toBe(auth);
      else if (authState === "invalid-store") expect(await readdir(stored)).toEqual([]);
      else await expect(lstat(stored)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(result)).not.toContain("configured-fixture-key");
    } finally { readCredential.mockRestore(); copyBack.mockRestore(); await rm(home, { recursive: true, force: true }); }
  });
  it.each(["local", "remote"].flatMap(transport => [false, true].map(linked => ({ transport, linked }))))
  ("seeds the selected subscription before isolated $transport setup (linked=$linked)", async ({ transport, linked }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-selected-auth-")));
    const auth = JSON.stringify({ tokens: { account_id: "fixture-account", id_token: "fixture-id", access_token: "fixture-access", refresh_token: "fixture-refresh" }, last_refresh: "2026-01-01T00:00:00.000Z" });
    const stored = join(home, linked ? "account-store.json" : "auth.json");
    let seeded = false;
    try {
      await writeFile(stored, auth, { mode: 0o600 });
      if (linked) await symlink(stored, join(home, "auth.json"));
      await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n[mcp_servers.host_only]\ncommand = "untrusted-host-tool"\n', { mode: 0o600 });
      await writeFile(join(home, "unassigned-private-file"), "must-not-copy");
      nativeProbe.mockImplementation(async input => {
        expect(input.environment._PAPERCLIP_NATIVE_SETUP_CODEX_AUTH_JSON_SECRET).toBeUndefined();
        const codexHome = join(input.runtimeDirectory, "codex-home");
        await prepareIsolatedCodexHome({ context: null, codexHome, sourceCodexHome: input.transportOptions.sourceCodexHome,
          apiKey: input.environment.CODEX_API_KEY ?? input.environment.OPENAI_API_KEY });
        const privateAuth = await readFile(join(codexHome, "auth.json"), "utf8").catch(() => null);
        seeded = privateAuth === auth;
        expect((await readFile(join(codexHome, "config.toml"), "utf8"))).not.toContain("untrusted-host-tool");
        if (!seeded) throw new Error("authentication required");
        if (linked) {
          const source = join(input.runtimeDirectory, "codex-credential-source");
          expect(input.transportOptions.sourceCodexHome).toBe(source);
          expect((await stat(source)).mode & 0o777).toBe(0o700);
          expect((await stat(join(source, "auth.json"))).mode & 0o777).toBe(0o600);
          expect((await readdir(source)).sort()).toEqual(["auth.json", "config.toml"]);
        }
        if (transport === "remote") {
          await remoteLauncher.mock.calls[0][0].ensureArtifact();
          const upload = sshExecute.mock.calls.find(([value]) => value.args?.[1]?.includes("/codex-home/auth.json"))?.[0];
          expect(upload).toBeDefined();
          expect(Buffer.from(upload!.stdin, "base64").toString("utf8")).toBe(auth);
          expect(upload!.args[1]).toContain("chmod 600");
        }
        await input.onCleanupConfirmed();
        return receipt("codex", "gpt-6.1-sol");
      });
      const testContext = transport === "remote" ? sshContext : { companyId: "company", adapterType: "paperclip_runner", config: {} };
      const result = await testNativeRunnerAuthentication({ ...testContext, config: { env: { CODEX_HOME: "/untrusted-configured-home", _PAPERCLIP_NATIVE_SETUP_CODEX_AUTH_JSON_SECRET: "spoofed-auth" } }, managedAiCredentialHome: home }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe("pass");
      expect(seeded).toBe(true);
      expect(await readFile(stored, "utf8")).toBe(auth);
      expect(JSON.stringify(result)).not.toContain("fixture-access");
      await expect(stat(nativeProbe.mock.calls[0][0].runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(execute).not.toHaveBeenCalled();
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each(["local", "remote"].flatMap(transport => ["dangling", "foreign-owner", "unsafe-mode", "oversize"].map(mode => ({ transport, mode }))))
  ("rejects $mode linked subscription before $transport provider admission", async ({ transport, mode }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-invalid-link-")));
    const stored = join(home, "account-store.json");
    let owner: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (mode !== "dangling") await writeFile(stored, mode === "oversize" ? "x".repeat(65_537) : '{"tokens":{"account_id":"fixture-account"}}', { mode: 0o600 });
      await symlink(stored, join(home, "auth.json"));
      if (mode === "unsafe-mode") await chmod(stored, 0o644);
      if (mode === "foreign-owner") owner = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      nativeProbe.mockResolvedValue(receipt("codex", "gpt-6.1-sol"));
      const testContext = transport === "remote" ? sshContext : { companyId: "company", adapterType: "paperclip_runner", config: {} };
      const result = await testNativeRunnerAuthentication({ ...testContext, managedAiCredentialHome: home }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe("fail");
      expect(nativeProbe).not.toHaveBeenCalled();
      expect(sshExecute).not.toHaveBeenCalled();
      if (mode === "dangling") expect(result.checks.some(check => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    } finally { owner?.mockRestore(); await rm(home, { recursive: true, force: true }); }
  });
  it.each(["local", "remote"])("redacts checked file credentials from %s native probe errors without exporting them to env", async transport => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-file-redaction-")));
    const auth = JSON.stringify({ tokens: { account_id: "fixture-account", id_token: "fixture-id", access_token: "fixture-access", refresh_token: "fixture-refresh" } });
    try {
      await writeFile(join(home, "account-store.json"), auth, { mode: 0o600 });
      await symlink(join(home, "account-store.json"), join(home, "auth.json"));
      nativeProbe.mockImplementation(async input => {
        expect(input.environment._PAPERCLIP_NATIVE_SETUP_CODEX_AUTH_JSON_SECRET).toBeUndefined();
        throw new Error("authentication failed: " + auth + " fixture-access fixture-refresh");
      });
      const testContext = transport === "remote" ? sshContext : { companyId: "company", adapterType: "paperclip_runner", config: {} };
      const result = await testNativeRunnerAuthentication({ ...testContext, managedAiCredentialHome: home }, "codex", "gpt-6.1-sol");
      expect(result.status).toBe("fail");
      expect(JSON.stringify(result)).not.toMatch(/fixture-account|fixture-access|fixture-refresh|fixture-id/);
      expect(result.checks[0].message).toContain("[REDACTED]");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each(["local", "remote"].flatMap(transport => [false, true].map(confirmed => ({ transport, confirmed }))))
  ("settles private linked credentials only after confirmed canceled $transport setup (confirmed=$confirmed)", async ({ transport, confirmed }) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "native-linked-cancel-")));
    const auth = '{"tokens":{"account_id":"fixture-account","access_token":"fixture-access"}}';
    try {
      await writeFile(join(home, "account-store.json"), auth, { mode: 0o600 });
      await symlink(join(home, "account-store.json"), join(home, "auth.json"));
      nativeProbe.mockImplementation(async input => {
        expect(await readFile(join(input.transportOptions.sourceCodexHome, "auth.json"), "utf8")).toBe(auth);
        if (confirmed) await input.onCleanupConfirmed();
        throw new Error("Native provider setup canceled");
      });
      const testContext = transport === "remote" ? sshContext : { companyId: "company", adapterType: "paperclip_runner", config: {} };
      expect((await testNativeRunnerAuthentication({ ...testContext, managedAiCredentialHome: home }, "codex", "gpt-6.1-sol")).status).toBe("fail");
      const root = nativeProbe.mock.calls[0][0].runtimeDirectory;
      if (confirmed) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(join(root, "codex-credential-source", "auth.json"), "utf8")).toBe(auth);
      expect(await readFile(join(home, "account-store.json"), "utf8")).toBe(auth);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it.each(["linux-arm64", "linux-x64"])("uses task staging and the selected %s SSH daemon without a provider pack", async target => {
    const selectedBinary = `/fixture/bin/${target}/paperclip-runnerd`;
    selectedRemoteRunner.mockResolvedValue(selectedBinary);
    let released = false;
    registerPrp.mockResolvedValue({ release: async () => { released = true; } });
    nativeProbe.mockImplementation(async input => {
      const registration = await input.transportOptions.controlPlaneRegistration({ marker: "native-authority" });
      expect(registration.connection).toMatchObject({ mode: "connect", connectUrl: expect.stringMatching(/^wss:\/\/paperclip\.example\.test\/api\/runner\/v1\/connect\//) });
      await registration.release();
      await input.onCleanupConfirmed();
      return receipt("codex", "gpt-6.1-sol");
    });
    expect((await testNativeRunnerAuthentication({ ...sshContext, config: { externallySandboxed: true, env: { OPENAI_API_KEY: "company-account", PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "true" }, modelReasoningEffort: "low" } }, "codex", "gpt-6.1-sol")).status).toBe("pass");
    const input = nativeProbe.mock.calls[0][0];
    expect(input).toMatchObject({ reasoningEffort: "low", environment: { OPENAI_API_KEY: "company-account" }, workingDirectory: expect.stringMatching(/^\/qa-workspace\/.paperclip-runtime\/paperclip-native-setup-.*\/filesystem\/workspace$/) });
    expect(input.transportOptions).toMatchObject({ runnerBinary: selectedBinary, codexCommand: expect.stringMatching(/\/bin\/codex$/), runnerFilesystemRoot: expect.stringMatching(/\/filesystem$/), externallySandboxed: false });
    expect(nativeArtifacts).toHaveBeenCalledWith(expect.objectContaining({ controllerRunnerBinary: selectedBinary, model: "gpt-6.1-sol", targetPlatformArtifactVerified: true }));
    expect(selectedRemoteRunner).toHaveBeenCalledExactlyOnceWith({ runner: { execute: sshExecute }, remoteCwd: "/qa-workspace", configuredPath: null });
    expect(selectedRunner).not.toHaveBeenCalled();
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
  it("reports an unavailable SSH target daemon before probing credentials or switching runtimes", async () => {
    selectedRemoteRunner.mockRejectedValue(new Error("runner_remote_artifact_unavailable: install the matching linux-arm64 Paperclip release"));
    const result = await testNativeRunnerAuthentication(sshContext, "codex", null);
    expect(result.status).toBe("fail"); expect(result.checks[0].message).toContain("matching linux-arm64 Paperclip release");
    expect(nativeArtifacts).not.toHaveBeenCalled(); expect(nativeProbe).not.toHaveBeenCalled();
    expect(selectedRunner).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
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
      await writeFile(join(home, "account-store.json"), auth("qa-account", "old", 120_000), { mode: 0o600 });
      await symlink(join(home, "account-store.json"), join(home, "auth.json"));
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
      expect(nativeProbe.mock.calls[0][0].transportOptions.sourceCodexHome).toBe(join(nativeProbe.mock.calls[0][0].runtimeDirectory, "codex-credential-source"));
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
  it.each(["arm64", "x64"].flatMap(controllerArch => ["arm64", "x64"].flatMap(targetArch => [false, true].map(explicit => ({ controllerArch, targetArch, explicit })))))
  ("uses target $targetArch artifacts and controller PRP from Mac $controllerArch for sandbox setup (override=$explicit)", async ({ controllerArch, targetArch, explicit }) => {
    vi.stubGlobal("process", { ...process, platform: "darwin", arch: controllerArch });
    const selectedBinary = `/controller/artifacts/linux-${targetArch}/paperclip-runnerd`;
    selectedRemoteRunner.mockResolvedValue(selectedBinary);
    if (explicit) vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", selectedBinary);
    nativeProbe.mockImplementation(async input => {
      const registration = await input.transportOptions.controlPlaneRegistration({});
      expect(registration.connection.mode).toBe("connect");
      await registration.release(); await input.onCleanupConfirmed();
      return receipt("codex", "gpt-6.1-sol");
    });
    const target = { ...context.executionTarget, runner: { execute: sshExecute } };
    expect((await testNativeRunnerAuthentication({ ...context, executionTarget: target }, "codex", "gpt-6.1-sol")).status).toBe("pass");
    expect(sshRunner).not.toHaveBeenCalled();
    expect(selectedRemoteRunner).toHaveBeenCalledExactlyOnceWith({ runner: target.runner, remoteCwd: target.remoteCwd, configuredPath: explicit ? selectedBinary : null });
    expect(selectedRunner).not.toHaveBeenCalled();
    expect(nativeArtifacts).toHaveBeenCalledWith(expect.objectContaining({ target, runner: target.runner, controllerRunnerBinary: selectedBinary, targetPlatformArtifactVerified: true }));
    expect(nativeProbe.mock.calls[0][0].transportOptions.runnerBinary).toBe(selectedBinary);
    expect(nativeProbe.mock.calls[0][0].transportOptions.externallySandboxed).toBe(true);
    expect(nativeArtifacts.mock.results[0].value.prepare).toHaveBeenCalledWith("dial_wss");
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["runner_remote_artifact_unavailable", "runner_remote_artifact_platform_mismatch"])("fails sandbox %s before setup or a controller fallback", async code => {
    selectedRemoteRunner.mockRejectedValue(new Error(code));
    const target = { ...context.executionTarget, runner: { execute: sshExecute } };
    const result = await testNativeRunnerAuthentication({ ...context, executionTarget: target }, "codex", "gpt-6.1-sol");
    expect(result.status).toBe("fail");
    expect(result.checks[0].message).toContain(code);
    expect(selectedRunner).not.toHaveBeenCalled(); expect(nativeArtifacts).not.toHaveBeenCalled();
    expect(nativeProbe).not.toHaveBeenCalled(); expect(sshExecute).not.toHaveBeenCalled();
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
    expect(nativeProbe.mock.calls[0][0].transportOptions.externallySandboxed).toBe(true);
    expect(connectionClose).toHaveBeenCalledOnce(); expect(registerPrp).not.toHaveBeenCalled();
  });
});

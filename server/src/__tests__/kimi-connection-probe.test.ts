import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256, KIMI_NODE_DISTRIBUTIONS, KIMI_NODE_VERSION, KIMI_RUNTIME_VERSION } from "../../../packages/paperclip-runner/src/drivers/acpx/kimi-closure-pins.js";
import { QUALIFIED_ACPX_PROFILES } from "../../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";

const mocks = vi.hoisted(() => ({ command: vi.fn(), local: vi.fn(), digest: vi.fn(), ssh: vi.fn(), prepare: vi.fn(), select: vi.fn(), wire: [] as Array<{ file: string; args: string[]; stdin: boolean }> }));
vi.mock("@paperclipai/adapter-utils/execution-target", () => ({ runAdapterExecutionTargetShellCommand: mocks.command }));
vi.mock("@paperclipai/adapter-utils/ssh", () => ({ runSshCommand: mocks.ssh }));
vi.mock("../services/native-runtime/native-session-executor.js", () => ({
  prepareRemoteProviderPackOnTarget: mocks.prepare, resolveRemoteProviderPackSource: mocks.select,
}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual,
    execFile: (file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") return actual.execFile(file, args, options, callback);
      mocks.wire.push({ file, args, stdin: false });
      return actual.execFile(process.execPath, ["-e", 'process.stdout.write("{}")'], options, callback);
    },
    spawn: (file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") return actual.spawn(file, args, options);
      mocks.wire.push({ file, args, stdin: true });
      return actual.spawn(process.execPath, ["-e", 'process.stdout.write(require("node:fs").readFileSync(0,"utf8"))'], options);
    },
  };
});
vi.mock("../vendor/paperclip-runner/live/index.js", async () => {
  const provider = await import("../../../packages/paperclip-runner/src/drivers/acpx/kimi-metadata-probe.js");
  return { probeKimiMetadata: mocks.local, kimiMetadataProbeDigest: mocks.digest,
    validateKimiMetadata: provider.validateKimiMetadata, kimiMetadataProbeNodeDigest: provider.kimiMetadataProbeNodeDigest };
});
import { probeKimiExecutionTarget as rawProbeKimiExecutionTarget } from "../services/kimi-connection-probe.js";

const model = "selected-model'; $(never-execute)";
const apiKey = "selected-secret'; $(never-execute)";
const digest = `sha256:${"a".repeat(64)}`;
const remote = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } as AdapterExecutionTarget;
const verified = () => ({ schema: "paperclip.kimi.metadata.v1", status: "verified", version: KIMI_RUNTIME_VERSION,
  nodeVersion: KIMI_NODE_VERSION, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest, target: "linux-x64",
  closureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256["linux-x64"]}`, model, contextLength: 1048576, promptSent: false });
const response = (value: unknown = verified(), exitCode = 0) => ({ stdout: JSON.stringify(value), stderr: "", exitCode, signal: null, timedOut: false });
const failed = (code: string) => ({ schema: "paperclip.kimi.metadata.v1", status: "failed", code, message: apiKey, promptSent: false });

const companyId = "candidate-company";
const pending = QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus === "pending";
function probeKimiExecutionTarget(apiKey: string, target: AdapterExecutionTarget | null | undefined, model: string) {
  const platform = target?.kind === "remote" ? "linux" : process.platform;
  const architecture = target?.kind === "remote" ? "x64" : process.arch;
  vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", JSON.stringify({ schema: "paperclip.acpx-candidate-admission.v1",
    companyId, agent: "kimi", model, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest,
    platform, architecture, expiresAt: Date.now() + 60_000,
    nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[`${platform}-${architecture}` as "darwin-arm64" | "linux-x64"]}` }));
  return rawProbeKimiExecutionTarget(apiKey, target, model, { companyId });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.digest.mockResolvedValue(digest);
  mocks.command.mockResolvedValue(response());
  mocks.ssh.mockResolvedValue({ stdout: JSON.stringify(verified()), stderr: "" });
  mocks.wire.length = 0;
  mocks.local.mockResolvedValue(verified());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Kimi setup on a selected execution target", () => {
  it.each(["sandbox", "ssh"])("uses admitted fixed bytes and only explicit credentials on %s", async transport => {
    vi.stubEnv("KIMI_API_KEY", "unselected-ambient-secret");
    vi.stubEnv("KIMI_CODE_BASE_URL", "https://unselected.example");
    const target = { ...remote, transport } as AdapterExecutionTarget;
    await expect(probeKimiExecutionTarget(apiKey, target, model)).resolves.toEqual(verified());
    expect(mocks.local).not.toHaveBeenCalled();
    const call = transport === "ssh" ? mocks.ssh.mock.calls[0] : mocks.command.mock.calls[0];
    expect(call).toBeTruthy();
    const command = call![transport === "ssh" ? 1 : 2], options = call![transport === "ssh" ? 2 : 3];
    if (transport === "ssh") {
      expect(mocks.command).not.toHaveBeenCalled();
      expect(mocks.ssh).toHaveBeenCalledOnce();
    } else {
      expect(mocks.command).toHaveBeenCalledOnce();
      expect(call![1]).toBe(target);
    }
    expect(command).toContain("pack=/opt/paperclip-runner/provider-pack");
    expect(command).toContain('node="$pack/provider-assets/kimi/linux-x64/runtime/node/bin/node"');
    expect(command).toContain('/usr/bin/sha256sum "$entry"');
    expect(command).toContain(digest.slice(7));
    expect(command).toContain('/usr/bin/sha256sum "$node"');
    expect(command).toContain(KIMI_NODE_DISTRIBUTIONS["linux-x64"].executableSha256);
    expect(command.indexOf('/usr/bin/sha256sum "$entry"')).toBeLessThan(command.indexOf('exec /usr/bin/env -i'));
    expect(command.indexOf('/usr/bin/sha256sum "$node"')).toBeLessThan(command.indexOf('exec /usr/bin/env -i'));
    expect(command).toContain("unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS");
    expect(command).toContain('PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT="$pack"');
    expect(command).not.toContain(model);
    expect(command).not.toContain(apiKey);
    if (transport === "ssh") {
      expect(options.env).toBeUndefined();
      const input = JSON.parse(options.stdin);
      expect(input).toMatchObject({ apiKey, model });
      if (pending) expect(input.candidateAdmission).toMatchObject({ companyId, agent: "kimi", model, platform: "linux", architecture: "x64", runId: expect.stringMatching(/^kimi-metadata-/), normalizedSessionId: expect.stringMatching(/^metadata-/) });
      else expect(input).not.toHaveProperty("candidateAdmission");
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(32000);
    } else {
      expect(options).toEqual({ cwd: "/workspace", env: { KIMI_API_KEY: apiKey, PAPERCLIP_KIMI_PROBE_MODEL: model, ...(pending ? { PAPERCLIP_ACPX_CANDIDATE_ADMISSION: expect.any(String) } : {}) }, timeoutSec: expect.any(Number), graceSec: 3 });
      expect(options.timeoutSec).toBeGreaterThan(0);
      expect(options.timeoutSec).toBeLessThanOrEqual(32);
    }
    expect(JSON.stringify(options)).not.toContain("unselected");
  });

  it("keeps local verification explicit and does not run a remote command", async () => {
    for (const target of [undefined, null, { kind: "local" } as AdapterExecutionTarget]) {
      await expect(probeKimiExecutionTarget(apiKey, target, model)).resolves.toEqual(verified());
    }
    expect(mocks.local).toHaveBeenCalledTimes(3);
    if (pending) expect(mocks.local).toHaveBeenCalledWith(model, apiKey, expect.objectContaining({ companyId, agent: "kimi", model, platform: process.platform, architecture: process.arch, runId: expect.stringMatching(/^kimi-metadata-/), normalizedSessionId: expect.stringMatching(/^metadata-/) }));
    else expect(mocks.local).toHaveBeenCalledWith(model, apiKey, undefined);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.digest).not.toHaveBeenCalled();
    mocks.local.mockResolvedValue(failed("KIMI_AUTH_REJECTED"));
    const error = await probeKimiExecutionTarget(apiKey, null, model).catch(error => error);
    expect(error).toMatchObject({ status: 422, details: { code: "KIMI_AUTH_REJECTED" } });
    expect(error.message).not.toContain(apiKey);
  });

  it("rejects task-only plugin hosting before credentials leave the server", async () => {
    const runnerTask = vi.fn();
    await expect(probeKimiExecutionTarget(apiKey, { ...remote, runnerTask } as AdapterExecutionTarget, model))
      .rejects.toMatchObject({ details: { code: "KIMI_INSTALLATION_INVALID" } });
    expect(runnerTask).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
    expect(mocks.digest).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("rejects absent or invalid key/model inputs before transmission", async () => {
    vi.stubEnv("KIMI_API_KEY", apiKey);
    for (const key of ["", " ", "key\nheader", "key\0header", "x".repeat(16385)]) {
      await expect(probeKimiExecutionTarget(key, remote, model)).rejects.toMatchObject({ details: { code: "KIMI_AUTH_REQUIRED" } });
    }
    for (const selected of ["", " ", "x\0y", "x".repeat(513), "\ud800"]) {
      await expect(probeKimiExecutionTarget(apiKey, remote, selected)).rejects.toMatchObject({ details: { code: "KIMI_MODEL_UNAVAILABLE" } });
    }
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });
});

describe("remote Kimi installation fallback and failure admission", () => {
  it("prepares the selected current pack before testing an older SDK image", async () => {
    // Actual credential-free artifacts from the failed source-16 qualification:
    // the immutable SDK image carries this older helper, while the controller
    // and complete selected Linux pack require the newer bytes.
    const imageHelper = "9e87ba56ce4663aa36f310a7eb6224bebb7d838be479c1741c3393577f2953c7";
    const selectedHelper = "22bf5125adbda95208d26762d4889de2b365a351b403ac92863f8f838f6d36fc";
    const installedRoot = "/workspace/.paperclip-runtime/paperclip-runner/provider-pack";
    const runner = { execute: vi.fn() };
    const selected = { configuredRoot: "/controller/complete-linux-pack",
      manifest: { payload: { target: { platform: "linux", architecture: "x64" } } } };
    mocks.select.mockReturnValue(selected);
    mocks.prepare.mockResolvedValue({ root: installedRoot, manifest: selected.manifest, source: "uploaded" });
    mocks.digest.mockResolvedValue(`sha256:${selectedHelper}`);
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/controller/complete-linux-pack");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "/controller/linux-runnerd");
    mocks.command.mockImplementation(async (_id, _target, command) => {
      expect(command).toContain(selectedHelper);
      if (command.includes("pack=/opt/paperclip-runner/provider-pack")) {
        expect(imageHelper).not.toBe(selectedHelper);
        return { ...response(), stdout: "", exitCode: 126 };
      }
      if (command.includes('pack="$HOME/.local/share/paperclip-runner/provider-pack"')) {
        return { ...response(), stdout: "", exitCode: 127 };
      }
      expect(command).toContain(`pack='${installedRoot}'`);
      return response();
    });
    const target = { ...remote, runner } as AdapterExecutionTarget;
    await expect(probeKimiExecutionTarget(apiKey, target, model)).resolves.toEqual(verified());
    expect(mocks.select).toHaveBeenCalledWith(selected.configuredRoot);
    expect(mocks.prepare).toHaveBeenCalledWith({ target, runner, configuredProviderPackRoot: selected.configuredRoot, manifest: selected.manifest });
    expect(mocks.command).toHaveBeenCalledOnce();
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.command.mock.invocationCallOrder[0]!);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["unreadable-source", "wrong-platform", "missing-transport", "failed-install"])("does not transmit credentials or use the baked image after %s", async failure => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/controller/selected-pack");
    mocks.select.mockReturnValue({ configuredRoot: "/controller/selected-pack",
      manifest: { payload: { target: { platform: failure === "wrong-platform" ? "darwin" : "linux", architecture: "x64" } } } });
    if (failure === "unreadable-source") mocks.select.mockImplementation(() => { throw new Error(apiKey); });
    if (failure === "failed-install") mocks.prepare.mockRejectedValue(new Error(apiKey));
    const target = { ...remote, ...(failure === "missing-transport" ? {} : { runner: { execute: vi.fn() } }) } as AdapterExecutionTarget;
    const error = await probeKimiExecutionTarget(apiKey, target, model).catch(error => error);
    expect(error).toMatchObject({ status: 422, details: { code: "KIMI_INSTALLATION_INVALID" } });
    expect(error.message).not.toContain(apiKey);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
    if (failure !== "failed-install") expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("uses the current qualification policy before selected-pack preparation", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "/controller/selected-pack");
    vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", JSON.stringify({ schema: "paperclip.acpx-candidate-admission.v1",
      companyId: "other-company", agent: "kimi", model, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest,
      platform: "linux", architecture: "x64", expiresAt: Date.now() + 60_000,
      nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256["linux-x64"]}` }));
    if (pending) {
      await expect(rawProbeKimiExecutionTarget(apiKey, remote, model, { companyId }))
        .rejects.toMatchObject({ details: { code: "KIMI_QUALIFICATION_REQUIRED" } });
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.command).not.toHaveBeenCalled();
    } else {
      const runner = { execute: vi.fn() };
      const selected = { configuredRoot: "/controller/selected-pack",
        manifest: { payload: { target: { platform: "linux", architecture: "x64" } } } };
      mocks.select.mockReturnValue(selected);
      mocks.prepare.mockResolvedValue({ root: "/workspace/.paperclip-runtime/paperclip-runner/provider-pack", manifest: selected.manifest, source: "uploaded" });
      await expect(rawProbeKimiExecutionTarget(apiKey, { ...remote, runner } as AdapterExecutionTarget, model, { companyId })).resolves.toEqual(verified());
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(mocks.command.mock.calls[0]![3].env).not.toHaveProperty("PAPERCLIP_ACPX_CANDIDATE_ADMISSION");
    }
  });

  it.each(["missing", "different-cli-bytes", "installation", "profile", "closure"])("tries only the fixed home pack after %s", async variant => {
    const first = variant === "missing" ? { ...response(), stdout: "", exitCode: 127 }
      : variant === "different-cli-bytes" ? { ...response(), stdout: "", exitCode: 126 }
        : variant === "installation" ? response(failed("KIMI_INSTALLATION_INVALID"), 1)
          : response({ ...verified(), [variant === "profile" ? "profileDigest" : "closureDigest"]: `sha256:${"0".repeat(64)}` });
    mocks.command.mockResolvedValueOnce(first).mockResolvedValueOnce(response());
    await expect(probeKimiExecutionTarget(apiKey, remote, model)).resolves.toEqual(verified());
    expect(mocks.command).toHaveBeenCalledTimes(2);
    expect(mocks.command.mock.calls[1]![2]).toContain('pack="$HOME/.local/share/paperclip-runner/provider-pack"');
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["KIMI_AUTH_REQUIRED", "KIMI_AUTH_REJECTED", "KIMI_MODEL_UNAVAILABLE", "KIMI_METADATA_TIMEOUT", "KIMI_METADATA_INVALID", "KIMI_PROVIDER_ERROR"])("keeps %s final and strips remote text", async code => {
    mocks.command.mockResolvedValueOnce(response(failed(code), 1));
    const error = await probeKimiExecutionTarget(apiKey, remote, model).catch(error => error);
    expect(error).toMatchObject({ status: 422, details: { code } });
    expect(error.message).not.toContain(apiKey);
    expect(mocks.command).toHaveBeenCalledOnce();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each([
    { stdout: "not json" }, { stdout: "x".repeat(65537) }, { signal: "SIGTERM" }, { timedOut: true },
    { exitCode: 1 }, { stdout: JSON.stringify({ ...verified(), promptSent: true }) },
    { stdout: JSON.stringify({ ...verified(), arbitrary: true }) },
  ])("never accepts malformed or interrupted success %#", alteration => {
    mocks.command.mockResolvedValue({ ...response(), ...alteration });
    return expect(probeKimiExecutionTarget(apiKey, remote, model)).rejects.toMatchObject({ details: { code: "KIMI_REQUEST_FAILED" } });
  });

  it("fails closed when no fixed remote installation matches without trying the controller", async () => {
    mocks.command.mockResolvedValue({ ...response(), stdout: "", exitCode: 127 });
    await expect(probeKimiExecutionTarget(apiKey, remote, model)).rejects.toMatchObject({ details: { code: "KIMI_INSTALLATION_INVALID" } });
    expect(mocks.command).toHaveBeenCalledTimes(2);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("rejects a receipt for another model or release platform", async () => {
    mocks.command.mockResolvedValue(response({ ...verified(), model: "unselected-model" }));
    await expect(probeKimiExecutionTarget(apiKey, remote, model)).rejects.toMatchObject({ details: { code: "KIMI_MODEL_UNAVAILABLE" } });
    expect(mocks.command).toHaveBeenCalledOnce();
    mocks.command.mockResolvedValue(response({ ...verified(), target: "darwin-arm64", closureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256["darwin-arm64"]}` }));
    await expect(probeKimiExecutionTarget(apiKey, remote, model)).rejects.toMatchObject({ details: { code: "KIMI_INSTALLATION_INVALID" } });
  });

  it("requires the current bundled probe before transmitting credentials", async () => {
    for (const value of ["", "arbitrary-path", `sha256:${"f".repeat(63)}`]) {
      mocks.digest.mockResolvedValue(value);
      await expect(probeKimiExecutionTarget(apiKey, remote, model)).rejects.toMatchObject({ details: { code: "KIMI_INSTALLATION_INVALID" } });
    }
    mocks.digest.mockRejectedValue(new Error(`missing build ${apiKey}`));
    const error = await probeKimiExecutionTarget(apiKey, remote, model).catch(error => error);
    expect(error.message).not.toContain(apiKey);
    expect(mocks.command).not.toHaveBeenCalled();
  });

  it("shares the 35 second budget across local digest and both remote locations", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.digest.mockImplementation(async () => { now += 2000; return digest; });
    mocks.command.mockImplementationOnce(async () => { now += 20_000; return { ...response(), stdout: "", exitCode: 127 }; });
    await expect(probeKimiExecutionTarget(apiKey, remote, model)).resolves.toEqual(verified());
    expect(mocks.command.mock.calls[0]![3].timeoutSec).toBe(30);
    expect(mocks.command.mock.calls[1]![3].timeoutSec).toBe(10);
    mocks.command.mockReset().mockImplementation(async () => { now += 35_001; return response(); });
    await expect(probeKimiExecutionTarget(apiKey, remote, model)).rejects.toMatchObject({ details: { code: "KIMI_REQUEST_FAILED" } });
  });

  it("sanitizes transport errors without trying another host or local credentials", async () => {
    mocks.command.mockRejectedValue(new Error(`transport ${apiKey}`));
    const error = await probeKimiExecutionTarget(apiKey, remote, model).catch(error => error);
    expect(error).toMatchObject({ details: { code: "KIMI_REQUEST_FAILED" } });
    expect(error.message).not.toContain(apiKey);
    expect(mocks.command).toHaveBeenCalledOnce();
    expect(mocks.local).not.toHaveBeenCalled();
  });
});


it("keeps the selected SSH key out of actual ssh argv and delivers it only over the existing stdin pipe", async () => {
  const wireApiKey = "wire-private-sentinel-abc123", wireModel = "wire-model";
  mocks.command.mockResolvedValue(response({ ...verified(), model: wireModel }));
  mocks.ssh.mockResolvedValue({ stdout: JSON.stringify({ ...verified(), model: wireModel }), stderr: "" });
  const spec = { host: "fixture.invalid", username: "fixture", port: 22, remoteWorkspacePath: "/workspace",
    privateKey: null, knownHosts: null, strictHostKeyChecking: true };
  const target = { kind: "remote", transport: "ssh", remoteCwd: "/workspace", spec } as AdapterExecutionTarget;
  await probeKimiExecutionTarget(wireApiKey, target, wireModel);
  const selected = mocks.ssh.mock.calls[0] ?? [spec, mocks.command.mock.calls[0]![2], { env: mocks.command.mock.calls[0]![3].env }];
  const { runSshCommand } = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>("@paperclipai/adapter-utils/ssh");
  const result = await runSshCommand(spec, selected[1], selected[2]);
  expect(mocks.wire).toHaveLength(1);
  const argv = JSON.stringify(mocks.wire[0]!.args);
  for (const value of [wireApiKey, wireModel, Buffer.from(wireApiKey).toString("base64"), Buffer.from(wireApiKey).toString("hex")]) expect(argv).not.toContain(value);
  expect(mocks.wire[0]!.stdin).toBe(true);
  const input = JSON.parse(result.stdout);
  expect(input).toMatchObject({ apiKey: wireApiKey, model: wireModel });
  if (pending) expect(input.candidateAdmission).toMatchObject({ companyId, model: wireModel, platform: "linux", architecture: "x64" });
  else expect(input).not.toHaveProperty("candidateAdmission");
});


it("loads the verified entry after decoding private stdin without interpreting key or model text", async () => {
  await probeKimiExecutionTarget(apiKey, { ...remote, transport: "ssh" } as AdapterExecutionTarget, model);
  const command = mocks.ssh.mock.calls[0]![1] as string;
  const bootstrap = command.match(/ -e '([^']+)' "\$entry"/)?.[1];
  expect(bootstrap).toBeTruthy();
  const root = await mkdtemp(path.join(os.tmpdir(), "kimi-probe-stdin-"));
  try {
    const entry = path.join(root, "entry.cjs");
    await writeFile(entry, 'process.stdout.write(JSON.stringify({ key:process.env.KIMI_API_KEY, model:process.env.PAPERCLIP_KIMI_PROBE_MODEL, ambient:process.env.UNSELECTED_SECRET }));');
    const execute = (input: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", bootstrap!, entry], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(input);
    });
    const result = await execute(JSON.stringify({ apiKey, model }));
    expect(result.code).toBe(0);expect(result.stderr).toBe("");expect(JSON.parse(result.stdout)).toEqual({ key:apiKey, model });
    for (const bad of ["not-json-private-sentinel", JSON.stringify({ apiKey: 1, model })]) {
      const result = await execute(bad);expect(result.code).toBe(1);expect(result.stdout).toBe("");expect(result.stderr).toBe("");
    }
  } finally { await rm(root, { recursive:true, force:true }); }
});

it("preserves SSH installation fallback and typed rejection while stripping transport text", async () => {
  const target = { ...remote, transport:"ssh" } as AdapterExecutionTarget;
  mocks.ssh.mockRejectedValueOnce(Object.assign(new Error(apiKey), { code:127, stdout:"" }));
  await expect(probeKimiExecutionTarget(apiKey, target, model)).resolves.toEqual(verified());
  expect(mocks.ssh).toHaveBeenCalledTimes(2);
  expect(mocks.ssh.mock.calls[1]![1]).toContain('pack="$HOME/.local/share/paperclip-runner/provider-pack"');
  for (const failure of [Object.assign(new Error(apiKey), { code:1, stdout:JSON.stringify(failed("KIMI_AUTH_REJECTED")) }),
    Object.assign(new Error(apiKey), { code:"ETIMEDOUT" })]) {
    mocks.ssh.mockRejectedValueOnce(failure);
    const error = await probeKimiExecutionTarget(apiKey,target,model).catch(error=>error);
    expect(error.details.code).toBe(failure.code===1?"KIMI_AUTH_REJECTED":"KIMI_REQUEST_FAILED");expect(error.message).not.toContain(apiKey);
  }
});

it("uses trusted authority only for a pending metadata Test and ordinary no-grant execution after release", async () => {
  if (!pending) {
    vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", "unrelated-invalid-authority");
    for (const context of [{}, { companyId }, { companyId, candidateAdmission: { allowAll: true } }]) {
      await expect(rawProbeKimiExecutionTarget(apiKey, remote, model, context)).resolves.toEqual(verified());
    }
    expect(mocks.command).toHaveBeenCalledTimes(3);
    for (const call of mocks.command.mock.calls) {
      expect(call[2]).not.toContain("PAPERCLIP_ACPX_CANDIDATE_ADMISSION");
      expect(call[3].env).not.toHaveProperty("PAPERCLIP_ACPX_CANDIDATE_ADMISSION");
    }
  } else {
  vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", undefined);
  vi.stubEnv("PAPERCLIP_RUNNER_ACPX_QUALIFICATION", JSON.stringify([{ agent: "kimi", model }]));
  for (const context of [{}, { companyId }, { companyId, candidateAdmission: { allowAll: true } }]) {
    await expect(rawProbeKimiExecutionTarget(apiKey, remote, model, context)).rejects.toMatchObject({ details: { code: "KIMI_QUALIFICATION_REQUIRED" } });
  }
  expect(mocks.local).not.toHaveBeenCalled(); expect(mocks.digest).not.toHaveBeenCalled();
  expect(mocks.command).not.toHaveBeenCalled(); expect(mocks.ssh).not.toHaveBeenCalled();
  await probeKimiExecutionTarget(apiKey, remote, model);
  mocks.command.mockClear(); mocks.digest.mockClear();
  for (const context of [{ companyId: "foreign" }, {}]) {
    await expect(rawProbeKimiExecutionTarget(apiKey, remote, model, context)).rejects.toMatchObject({ details: { code: "KIMI_QUALIFICATION_REQUIRED" } });
  }
  const grant = JSON.parse(process.env.PAPERCLIP_ACPX_CANDIDATE_ADMISSION!);
  vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", JSON.stringify({ ...grant, expiresAt: 0 }));
  await expect(rawProbeKimiExecutionTarget(apiKey, remote, model, { companyId })).rejects.toMatchObject({ details: { code: "KIMI_QUALIFICATION_REQUIRED" } });
  expect(mocks.command).not.toHaveBeenCalled(); expect(mocks.digest).not.toHaveBeenCalled();
  }
});

it("omits candidate authority entirely for released metadata Test, including the actual remote shell environment", async () => {
  const path = "../vendor/paperclip-runner/index.js";
  vi.doMock(path, async () => {
    const actual = await vi.importActual<typeof import("../vendor/paperclip-runner/index.js")>(path);
    return { ...actual, QUALIFIED_ACPX_PROFILES: { ...actual.QUALIFIED_ACPX_PROFILES,
      kimi: { ...actual.QUALIFIED_ACPX_PROFILES.kimi, qualificationStatus: undefined } } };
  });
  vi.resetModules();
  const root = await mkdtemp(os.tmpdir() + "/kimi-released-probe-");
  try {
    vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", undefined);
    const { probeKimiExecutionTarget } = await import("../services/kimi-connection-probe.js");
    const { resolveKimiCandidateAdmission } = await import("../services/native-runtime/acpx-qualification.js");
    expect(resolveKimiCandidateAdmission({ companyId, model }, { PAPERCLIP_ACPX_CANDIDATE_ADMISSION: "stale-invalid-candidate" })).toBeUndefined();
    await probeKimiExecutionTarget(apiKey, remote, model, { companyId });
    const command = mocks.command.mock.calls[0]![2] as string;
    const options = mocks.command.mock.calls[0]![3];
    expect(command).not.toContain("PAPERCLIP_ACPX_CANDIDATE_ADMISSION");
    expect(options.env).not.toHaveProperty("PAPERCLIP_ACPX_CANDIDATE_ADMISSION");
    const entry = root + "/environment.cjs";
    await writeFile(entry, 'process.stdout.write(JSON.stringify({candidatePresent:Object.hasOwn(process.env,"PAPERCLIP_ACPX_CANDIDATE_ADMISSION")}));');
    const suffix = command.slice(command.lastIndexOf("exec /usr/bin/env -i"));
    const result = await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", suffix], { env: { node: process.execPath, entry, pack: root,
        KIMI_API_KEY: apiKey, PAPERCLIP_KIMI_PROBE_MODEL: model, PAPERCLIP_ACPX_CANDIDATE_ADMISSION: "ambient-forgery" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    });
    expect(result).toEqual({ code: 0, stdout: JSON.stringify({ candidatePresent: false }), stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
    vi.doUnmock(path); vi.resetModules();
  }
});

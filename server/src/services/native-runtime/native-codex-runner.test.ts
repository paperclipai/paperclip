import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runner from "../../vendor/paperclip-runner/index.js";

import type { PaperclipSemanticToolDefinition } from "../../vendor/paperclip-runner/index.js";
import {
  buildNativeRunnerArguments,
  buildNativeRunnerPreparePayload,
  resolvePaperclipRunnerBinary,
  resolveRemotePaperclipRunnerBinary,
} from "./native-codex-runner.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("installed runner selection", () => {
  it("uses the runner's platform-aware packaged selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runner-selection-"));
    const binary = join(root, "paperclip-runnerd");
    try {
      await writeFile(binary, "test executable", { mode: 0o700 });
      const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockReturnValue(binary);
      expect(resolvePaperclipRunnerBinary("")).toBe(binary);
      expect(select).toHaveBeenCalledOnce();
      expect(resolvePaperclipRunnerBinary(join(root, "missing"))).toBe(binary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit usable override and rejects a relative override", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-runner-selection-"));
    const binary = join(root, "configured-runnerd");
    try {
      await writeFile(binary, "test executable", { mode: 0o700 });
      const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockImplementation(() => {
        throw new Error("must not inspect package when override is usable");
      });
      expect(resolvePaperclipRunnerBinary(binary)).toBe(binary);
      expect(select).not.toHaveBeenCalled();
      expect(() => resolvePaperclipRunnerBinary("relative-runnerd")).toThrow("absolute path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("selected remote daemon target", () => {
  function header(target: string) {
    const bytes = Buffer.alloc(64);
    if (target.startsWith("darwin")) {
      bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
    } else {
      bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(target.endsWith("arm64") ? 183 : 62, 18);
    }
    return bytes;
  }
  const remote = (stdout: string, overrides = {}) => ({ execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: null, startedAt: null, ...overrides })) });
  it.each([
    ["Linux", "aarch64", "linux", "arm64"], ["Linux", "x86_64", "linux", "x64"],
    ["Darwin", "arm64", "darwin", "arm64"], ["Darwin", "x86_64", "darwin", "x64"],
  ] as const)("uses the packaged %s/%s daemon independent of the controller", async (os, arch, platform, architecture) => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-ssh-daemon-"));
    const binary = join(root, "paperclip-runnerd");
    try {
      await writeFile(binary, header(`${platform}-${architecture}`));
      const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockReturnValue(binary);
      const target = remote(`${os}\n${arch}\n`);
      expect(await resolveRemotePaperclipRunnerBinary({ runner: target, remoteCwd: "/selected-workspace" })).toBe(binary);
      expect(select).toHaveBeenCalledExactlyOnceWith(platform, architecture);
      expect(target.execute).toHaveBeenCalledExactlyOnceWith({ command: "sh", args: ["-c", "uname -s; uname -m"], cwd: "/selected-workspace", bypassSession: true, timeoutMs: 10_000 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["arm64", "x64"].flatMap(controllerArch => ["arm64", "x64"].map(targetArch => ({ controllerArch, targetArch }))))(
    "selects the actual Linux $targetArch sandbox bytes on a Mac $controllerArch controller", async ({ controllerArch, targetArch }) => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-sandbox-daemon-"));
      const binary = join(root, "paperclip-runnerd");
      try {
        vi.stubGlobal("process", { ...process, platform: "darwin", arch: controllerArch });
        await writeFile(binary, header(`linux-${targetArch}`));
        const controllerBinary = join(root, "controller-runnerd");
        await writeFile(controllerBinary, header(`darwin-${controllerArch}`), { mode: 0o700 });
        vi.stubEnv("PAPERCLIP_RUNNER_BINARY", controllerBinary);
        const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockReturnValue(binary);
        const target = remote(`Linux\n${targetArch === "arm64" ? "aarch64" : "x86_64"}\n`);
        expect(await resolveRemotePaperclipRunnerBinary({ runner: target, remoteCwd: "/sandbox-workspace" })).toBe(binary);
        expect(select).toHaveBeenCalledExactlyOnceWith("linux", targetArch);
        expect(target.execute).toHaveBeenCalledExactlyOnceWith({ command: "sh", args: ["-c", "uname -s; uname -m"], cwd: "/sandbox-workspace", bypassSession: true, timeoutMs: 10_000 });
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  it.each(["linux", "darwin"].flatMap(platform => ["arm64", "x64"].map(architecture => ({ platform, architecture }))))(
    "prefers the supervisor's fresh $platform/$architecture override for the same-host target", async ({ platform, architecture }) => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-same-host-daemon-"));
      try {
        vi.stubGlobal("process", { ...process, platform, arch: architecture });
        const fresh = join(root, "fresh-runnerd"), stale = join(root, "stale-packaged-runnerd");
        await writeFile(fresh, Buffer.concat([header(`${platform}-${architecture}`), Buffer.from("fresh")]), { mode: 0o700 });
        await writeFile(stale, Buffer.concat([header(`${platform}-${architecture}`), Buffer.from("stale")]), { mode: 0o700 });
        vi.stubEnv("PAPERCLIP_RUNNER_BINARY", fresh);
        const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockReturnValue(stale);
        const target = remote(`${platform === "linux" ? "Linux" : "Darwin"}\n${architecture === "arm64" ? "arm64" : "x86_64"}\n`);
        expect(await resolveRemotePaperclipRunnerBinary({ runner: target, remoteCwd: "/workspace" })).toBe(fresh);
        expect(select).not.toHaveBeenCalled();
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );
  it.each(["missing", "relative", "malformed", "wrong-architecture"])("retains same-host override policy and target validation (%s)", async scenario => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-same-host-daemon-"));
    try {
      vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
      const override = join(root, "configured-runnerd"), fallback = join(root, "packaged-runnerd");
      if (scenario !== "missing") await writeFile(override, scenario === "malformed" ? Buffer.alloc(64) : header("linux-arm64"), { mode: 0o700 });
      await writeFile(fallback, header("linux-x64"), { mode: 0o700 });
      vi.stubEnv("PAPERCLIP_RUNNER_BINARY", scenario === "relative" ? "relative-runnerd" : override);
      vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockReturnValue(fallback);
      const request = resolveRemotePaperclipRunnerBinary({ runner: remote("Linux\nx86_64\n"), remoteCwd: "/workspace" });
      if (scenario === "missing") expect(await request).toBe(fallback);
      else await expect(request).rejects.toThrow(scenario === "relative" ? "PAPERCLIP_RUNNER_BINARY must be an absolute path" : "runner_remote_artifact_platform_mismatch");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("ignores a relative controller override when the actual target differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-cross-host-daemon-"));
    try {
      vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
      vi.stubEnv("PAPERCLIP_RUNNER_BINARY", "relative-controller-runnerd");
      const binary = join(root, "linux-runnerd");
      await writeFile(binary, header("linux-arm64"));
      const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockReturnValue(binary);
      expect(await resolveRemotePaperclipRunnerBinary({ runner: remote("Linux\naarch64\n"), remoteCwd: "/workspace" })).toBe(binary);
      expect(select).toHaveBeenCalledExactlyOnceWith("linux", "arm64");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["matching", "wrong-architecture", "malformed", "missing"])("verifies an explicit controller-owned remote artifact (%s)", async scenario => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-ssh-daemon-"));
    const binary = join(root, "configured-runnerd");
    try {
      vi.stubGlobal("process", { ...process, platform: "linux", arch: "arm64" });
      vi.stubEnv("PAPERCLIP_RUNNER_BINARY", "invalid-relative-controller-override");
      if (scenario !== "missing") await writeFile(binary, scenario === "malformed" ? Buffer.alloc(64) : header(scenario === "matching" ? "linux-arm64" : "linux-x64"));
      const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary");
      const request = resolveRemotePaperclipRunnerBinary({ runner: remote("Linux\naarch64\n"), remoteCwd: "/workspace", configuredPath: binary });
      if (scenario === "matching") expect(await request).toBe(binary);
      else await expect(request).rejects.toThrow(scenario === "missing" ? "runner_remote_artifact_unavailable" : "runner_remote_artifact_platform_mismatch");
      expect(select).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps missing package targets actionable without a controller or legacy fallback", async () => {
    const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary").mockImplementation(() => { throw new Error("runner_remote_artifact_unavailable: install the matching release"); });
    await expect(resolveRemotePaperclipRunnerBinary({ runner: remote("Linux\naarch64\n"), remoteCwd: "/workspace" })).rejects.toThrow("runner_remote_artifact_unavailable");
    expect(select).toHaveBeenCalledExactlyOnceWith("linux", "arm64");
  });
  it.each([
    ["Linux\naarch64\n", { exitCode: 1 }], ["Linux\naarch64\n", { timedOut: true }],
    ["Linux\nriscv64\n", {}], ["FreeBSD\nx86_64\n", {}], ["", {}],
  ])("fails a missing, failed or unsupported platform probe (%s)", async (stdout, overrides) => {
    const select = vi.spyOn(runner, "defaultCapabilityRunnerdBinary");
    await expect(resolveRemotePaperclipRunnerBinary({ runner: remote(stdout as string, overrides), remoteCwd: "/workspace" })).rejects.toThrow("runner_remote_artifact_platform_mismatch");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("buildNativeRunnerArguments", () => {
  it("binds every durable identity without exposing the bootstrap ticket", () => {
    const args = buildNativeRunnerArguments({
      connectUrl: "ws://127.0.0.1:3000/api/runner/v1/connect/run-1",
      stateDirectory: "/tmp/runner-state",
      runnerInstanceId: "runner-1",
      environmentLeaseId: "lease-1",
      runId: "run-1",
      normalizedSessionId: "session-1",
      turnId: "turn-1",
      itemId: "item-1",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      maxRuntimeMs: 60_000,
    });
    expect(args).toContain("--connect-url");
    expect(args).toContain("--runner-digest");
    expect(args.join(" ")).not.toContain("bootstrap");
  });
});

const tool: PaperclipSemanticToolDefinition = {
  name: "get_task_context",
  description: "Read the active task context.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  annotations: {
    semanticContract: "paperclip.semantic-action.v1",
    version: 1,
    placement: "always",
    effect: "read",
    requiredClaims: [],
  },
};

describe("buildNativeRunnerPreparePayload", () => {
  it("binds the coordinator tool projection to run.prepare", () => {
    expect(buildNativeRunnerPreparePayload({
      cwd: "/workspace",
      model: "test-model",
      resumeProviderSessionId: "thread-1",
      completionContract: { revision: "1", criterionIds: ["objective"] },
      semanticTools: [tool],
      providerLaunch: {
        command: "/bin/fake-codex",
        args: ["app-server"],
        providerVersion: "fake-1",
      },
    })).toMatchObject({
      provider: {
        kind: "codex",
        provider: "codex",
        driver: "codex_app_server",
        providerSessionId: "thread-1",
      },
      authorizedTools: {
        schema: "paperclip.runner.authorized-tools.v1",
        schemaVersion: 1,
        catalogDigest:
          "sha256:4e0332535c9e2ff1f5e43089517ee1b46654bfc9cb2ed51efbea4be50db21009",
        operations: [{ operationId: "get_task_context", version: 1 }],
      },
    });
  });
});

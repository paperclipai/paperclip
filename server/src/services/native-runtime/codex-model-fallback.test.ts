import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import {
  codexModelFallbackCandidates,
  compatibleCodexModel,
  readRemoteCodexModelCliVersion,
  selectCodexModelFallback,
} from "./codex-model-fallback.js";

describe("bounded Codex model fallback", () => {
  it("keeps capability classes separate and appends the stable default once", () => {
    expect(codexModelFallbackCandidates("gpt-6.1-sol")).toEqual(["gpt-6-sol", "gpt-5.6-sol"]);
    expect(codexModelFallbackCandidates("gpt-6-luna")).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    expect(codexModelFallbackCandidates("gpt-6-astra")).toEqual(["gpt-5.6-sol"]);
    expect(codexModelFallbackCandidates("gpt-5.6-sol")).toEqual([]);
  });

  it("uses the default after same-class candidates are unavailable, then stops", () => {
    const compatible = vi.fn((model: string) => model === "gpt-5.6-sol");
    expect(selectCodexModelFallback("gpt-6-luna", compatible)).toBe("gpt-5.6-sol");
    expect(compatible.mock.calls).toEqual([["gpt-5.6-luna"], ["gpt-5.6-sol"]]);
    const unavailable = vi.fn(() => false);
    expect(selectCodexModelFallback("gpt-6.1-sol", unavailable)).toBeNull();
    expect(unavailable.mock.calls).toEqual([["gpt-6-sol"], ["gpt-5.6-sol"]]);
  });

  it.each([
    ["gpt-6.1-sol", "0.159.0"], ["gpt-6-sol", "0.157.0"], ["gpt-5.6-sol", "0.156.0"],
    ["team-model", "0.156.0"], [null, "0.156.0"], ["gpt-6.1-sol", null],
    ["gpt-6.1-sol", "0.148.9"], ["gpt-6.1-sol", "0.161.0"], ["gpt-6.1-sol", "0.160.0-alpha.1"],
  ])("preserves %s on %s when no safe startup substitution applies", (model, version) => {
    expect(compatibleCodexModel(model, version)).toBe(model);
  });
});

function remoteTarget(stdout = "codex-cli 0.156.0", overrides = {}) {
  const execute = vi.fn(async (command: { command: string; args?: string[] }) => ({
    exitCode: 0, signal: null, timedOut: false, stderr: "",
    stdout: command.command === "sh" ? "/opt/paperclip-runner/bin/codex\n" : stdout,
    ...(command.command !== "sh" ? overrides : {}),
  }));
  const target = { kind: "remote", transport: "sandbox", remoteCwd: "/workspace",
    runner: { execute } } as unknown as AdapterExecutionTarget;
  return { target, execute };
}

describe("remote model compatibility preflight", () => {
  it.each(["discovery", "version"])("defers to launch verification when the %s probe rejects", async (phase) => {
    const { target, execute } = remoteTarget();
    if (phase === "version") {
      execute.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false,
        stderr: "", stdout: "/opt/paperclip-runner/bin/codex\n" });
    }
    execute.mockRejectedValueOnce(new Error("temporary sandbox command failure"));
    await expect(readRemoteCodexModelCliVersion({ model: "gpt-6.1-sol", target })).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(phase === "version" ? 2 : 1);
  });

  it("checks the image CLI without invoking a provider turn or installing software", async () => {
    const { target, execute } = remoteTarget();
    const version = await readRemoteCodexModelCliVersion({ model: "gpt-6.1-sol", target });
    expect(version).toBe("0.156.0");
    expect(compatibleCodexModel("gpt-6.1-sol", version)).toBe("gpt-5.6-sol");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith({ command: "/opt/paperclip-runner/bin/codex",
      args: ["--version"], cwd: "/workspace", bypassSession: true, timeoutMs: 30_000 });
  });

  it.each([
    { remoteCodexPath: "/controller/codex" },
    { remoteCodexNpmSpec: "@openai/codex@0.160.0" },
    { model: "gpt-5.6-sol" },
    { model: "custom-model" },
    { target: { kind: "local" } as AdapterExecutionTarget },
  ])("preserves explicit artifacts, install pins, and unqualified models: %j", async (overrides) => {
    const { target, execute } = remoteTarget();
    expect(await readRemoteCodexModelCliVersion({ model: "gpt-6.1-sol", target, ...overrides })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["codex-cli 0.148.9", {}], ["codex-cli 0.161.0", {}], ["codex-cli 0.160.0-alpha.1", {}],
    ["codex-cli 0.156.0\ncodex-cli 0.160.0", {}], ["codex-cli 0.156.0", { timedOut: true }],
    ["codex-cli 0.156.0", { exitCode: 1 }],
  ])("keeps the launch verifier authoritative for invalid probes: %s %j", async (stdout, overrides) => {
    expect(await readRemoteCodexModelCliVersion({ model: "gpt-6.1-sol", target: remoteTarget(stdout, overrides).target })).toBeNull();
  });
});

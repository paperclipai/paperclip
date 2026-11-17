/**
 * TECH-8174: testEnvironment on a remote target probes inside the target (never this host's
 * Hermes, python3 or ~/.hermes), and applies the same gates as a sandbox run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const h = vi.hoisted(() => ({
  processCalls: [] as Array<{ command: string; args: string[]; env: Record<string, string> }>,
  resolvable: vi.fn(async () => {}),
  execFile: vi.fn(),
  probe: vi.fn(async (): Promise<{ supported: true } | { supported: false; reason: "unsupported" | "unknown" | "timeout" | "error"; message: string }> => ({ supported: true })),
}));

vi.mock("./router-readiness-remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./router-readiness-remote.js")>()),
  probeHermesRouterSupportInTarget: h.probe,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: h.execFile };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: h.resolvable,
    runAdapterExecutionTargetProcess: vi.fn(async (_runId: string, _t: unknown, command: string, args: string[], options: { env: Record<string, string> }) => {
      h.processCalls.push({ command, args, env: options.env });
      return { exitCode: 0, signal: null, timedOut: false, stdout: "Hermes Agent v0.19.0-pod\n", stderr: "", pid: null, startedAt: new Date().toISOString() };
    }),
  };
});

import { testEnvironment } from "./test.js";
import { HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE } from "./execute-sandbox.js";

const sandboxTarget: AdapterExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "kubernetes", remoteCwd: "/workspace" };

function run(config: Record<string, unknown>, executionTarget: AdapterExecutionTarget = sandboxTarget) {
  return testEnvironment({ companyId: "c", adapterType: "hermes_local", config, executionTarget, environmentName: "eks-proof" });
}

afterEach(() => {
  vi.clearAllMocks();
  h.processCalls.length = 0;
});

describe("hermes testEnvironment on a remote target (TECH-8174)", () => {
  it("runs hermes --version inside the sandbox and nothing on the host", async () => {
    const result = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.resolvable).toHaveBeenCalledWith("/opt/hermes/bin/hermes", sandboxTarget, "/workspace", {});
    expect(h.processCalls).toEqual([{ command: "/opt/hermes/bin/hermes", args: ["--version"], env: {} }]);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "hermes_environment_target", message: "Probing inside environment: eks-proof" }),
      expect.objectContaining({ code: "hermes_version", message: "Hermes Agent version: Hermes Agent v0.19.0-pod" }),
      expect.objectContaining({ code: "hermes_model_configured" }),
    ]));
    expect(result.status).toBe("pass");
  });

  it("fails when the image has no Hermes", async () => {
    h.resolvable.mockRejectedValueOnce(new Error('Command "/opt/hermes/bin/hermes" is not installed'));
    const result = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } });
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "hermes_cli_not_found" })]));
    expect(h.processCalls).toHaveLength(0);
  });

  it("reports the run's gates: missing credential and memory provider", async () => {
    const result = await run({ provider: "openai-api", model: "gpt-5.4", memoryProvider: "mem0", env: {} });
    expect(result.status).toBe("fail");
    expect(result.checks.map((c) => c.code)).toEqual(expect.arrayContaining([
      "hermes_memory_sandbox_unsupported",
      "hermes_explicit_credential_required",
    ]));
  });

  it("verifies a Router config inside the sandbox (version and registry probe), nothing on the host", async () => {
    const result = await run({ provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "rr-x" } });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.probe).toHaveBeenCalledWith(expect.objectContaining({ target: sandboxTarget, cwd: "/workspace" }));
    expect(result.checks.map((c) => c.code)).toEqual(expect.arrayContaining([
      "hermes_router_key_found",
      "hermes_version",
      "hermes_router_supported",
    ]));
    expect(result.status).toBe("pass");
  });

  it("reports a Router config with no key binding or with extraArgs", async () => {
    h.probe.mockResolvedValueOnce({ supported: false, reason: "unsupported", message: "no native router" });
    const result = await run({ provider: "router", model: "auto-jev-routing", extraArgs: ["-v"], env: { OPENAI_API_KEY: "sk-x" } });
    expect(result.status).toBe("fail");
    expect(result.checks.map((c) => c.code)).toEqual(expect.arrayContaining([
      "hermes_router_extra_args",
      "hermes_router_key_missing",
      "hermes_router_unsupported",
    ]));
  });

  it("reports a Router key the run could not redact", async () => {
    const result = await run({ provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "x".repeat(100_000) } });
    expect(result.checks.map((c) => c.code)).toContain("hermes_router_key_unredactable");
    expect(result.status).toBe("fail");
  });

  it("still refuses a Router config on an SSH target", async () => {
    const ssh = { kind: "remote", transport: "ssh", remoteCwd: "/srv", spec: {} } as unknown as AdapterExecutionTarget;
    const result = await run({ provider: "router", model: "auto-jev-routing", env: { RAMP_ROUTER_API_KEY: "rr-x" } }, ssh);
    expect(result.checks.map((c) => c.code)).toEqual(["hermes_router_remote_unsupported"]);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("refuses sandbox providers other than Kubernetes, and required command scan, before launching anything", async () => {
    const modal = { ...sandboxTarget, providerKey: "modal" } as AdapterExecutionTarget;
    const r1 = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } }, modal);
    expect(r1.checks.map((c) => c.code)).toEqual(["hermes_sandbox_provider_unsupported"]);
    process.env.PAPERCLIP_HERMES_COMMAND_SCAN = "required";
    try {
      const r2 = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } });
      expect(r2.checks.map((c) => c.code)).toEqual(["hermes_command_scan_sandbox_unsupported"]);
    } finally {
      delete process.env.PAPERCLIP_HERMES_COMMAND_SCAN;
    }
    expect(h.processCalls).toHaveLength(0);
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("reports a custom Hermes command as untrusted without probing", async () => {
    const result = await run({ hermesCommand: "/tmp/evil", provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } });
    expect(result.checks.map((c) => c.code)).toContain("hermes_untrusted_launcher");
    expect(h.processCalls).toHaveLength(0);
  });

  it("refuses managed AI connections like the run does", async () => {
    for (const config of [{ managedAiRouting: { id: "x" } }, { managedAiConnection: { id: "x" } }]) {
      const result = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" }, ...config });
      expect(result.checks.map((c) => c.code)).toEqual(["hermes_remote_probe_unsupported"]);
    }
    expect(h.processCalls).toHaveLength(0);
  });

  it("refuses an SSH target", async () => {
    const ssh = { kind: "remote", transport: "ssh", remoteCwd: "/srv", spec: {} } as unknown as AdapterExecutionTarget;
    const result = await run({ provider: "openai-api", model: "gpt-5.4", env: { OPENAI_API_KEY: "sk-x" } }, ssh);
    expect(result.status).toBe("fail");
    expect(result.checks).toEqual([expect.objectContaining({ code: "hermes_ssh_unsupported", message: HERMES_SANDBOX_SSH_UNSUPPORTED_MESSAGE })]);
    expect(h.processCalls).toHaveLength(0);
    expect(h.execFile).not.toHaveBeenCalled();
  });
});

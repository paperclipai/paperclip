import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockRunTargetShellCommand = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAdapterExecutionTargetShellCommand: mockRunTargetShellCommand,
}));

import { assertCodexCredentialsLaunchable, execute } from "./execute.js";

describe("codex managed-home auth fail-fast", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("fails fast when a managed CODEX_HOME has no auth.json and OPENAI_API_KEY is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-failfast-"));
    cleanupDirs.push(root);

    const paperclipHome = path.join(root, "paperclip-home");
    const emptySharedHome = path.join(root, "shared-codex-home");
    const workspaceDir = path.join(root, "workspace");
    // A managed per-agent home with no credentials seeded into it.
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    await fs.mkdir(emptySharedHome, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    // Source home has no auth.json, so nothing is symlinked into the managed home.
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("CODEX_HOME", emptySharedHome);

    await expect(
      execute({
        runId: "run-failfast",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          engine: "cli",
          command: "codex",
          cwd: workspaceDir,
          env: {
            CODEX_HOME: managedAgentHome,
            OPENAI_API_KEY: "",
          },
        },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow(/no Codex credentials provisioned for managed home/);

    // The managed home must not have been left with a usable auth.json.
    await expect(fs.access(path.join(managedAgentHome, "auth.json"))).rejects.toBeTruthy();
  });
});

describe("codex sandbox-target credential gate", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    mockRunTargetShellCommand.mockReset();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeCredentiallessManagedHome() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-sandbox-gate-"));
    cleanupDirs.push(root);
    const paperclipHome = path.join(root, "paperclip-home");
    const emptySharedHome = path.join(root, "shared-codex-home");
    await fs.mkdir(emptySharedHome, { recursive: true });
    const managedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    const env = {
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
      CODEX_HOME: emptySharedHome,
    } as NodeJS.ProcessEnv;
    return { env, managedAgentHome };
  }

  const sandboxTarget = {
    kind: "remote",
    transport: "sandbox",
  } as unknown as Parameters<typeof assertCodexCredentialsLaunchable>[0]["target"];

  it("launches against a sandbox that carries its own Codex login", async () => {
    const { env, managedAgentHome } = await makeCredentiallessManagedHome();
    mockRunTargetShellCommand.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    const logs: string[] = [];

    await expect(
      assertCodexCredentialsLaunchable({
        runId: "run-sandbox-login",
        companyId: "company-1",
        configuredCodexHome: managedAgentHome,
        configuredApiKey: null,
        effectiveCodexHome: managedAgentHome,
        target: sandboxTarget,
        cwd: "/workspace",
        env,
        onLog: async (_stream, line) => {
          logs.push(line);
        },
      }),
    ).resolves.toBeUndefined();

    expect(mockRunTargetShellCommand).toHaveBeenCalledWith(
      "run-sandbox-login",
      sandboxTarget,
      'test -f "$HOME/.codex/auth.json"',
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(logs.join("")).toContain("sandbox's own Codex login");
  });

  it("fails a sandbox run when neither the host nor the sandbox has credentials", async () => {
    const { env, managedAgentHome } = await makeCredentiallessManagedHome();
    mockRunTargetShellCommand.mockResolvedValue({ exitCode: 1, timedOut: false, stdout: "", stderr: "" });

    await expect(
      assertCodexCredentialsLaunchable({
        runId: "run-sandbox-nologin",
        companyId: "company-1",
        configuredCodexHome: managedAgentHome,
        configuredApiKey: null,
        effectiveCodexHome: managedAgentHome,
        target: sandboxTarget,
        cwd: "/workspace",
        env,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/the sandbox has no Codex login/);
  });

  it("proceeds with a warning when the sandbox login probe fails operationally", async () => {
    const { env, managedAgentHome } = await makeCredentiallessManagedHome();
    mockRunTargetShellCommand.mockRejectedValue(new Error("transport lost"));
    const stderrLines: string[] = [];

    await expect(
      assertCodexCredentialsLaunchable({
        runId: "run-probe-error",
        companyId: "company-1",
        configuredCodexHome: managedAgentHome,
        configuredApiKey: null,
        effectiveCodexHome: managedAgentHome,
        target: sandboxTarget,
        cwd: "/workspace",
        env,
        onLog: async (stream, line) => {
          if (stream === "stderr") stderrLines.push(line);
        },
      }),
    ).resolves.toBeUndefined();
    expect(stderrLines.join("")).toContain("Could not verify the sandbox's Codex login");
  });

  it("treats a probe timeout as unverifiable, not as a missing credential", async () => {
    const { env, managedAgentHome } = await makeCredentiallessManagedHome();
    mockRunTargetShellCommand.mockResolvedValue({ exitCode: 0, timedOut: true, stdout: "", stderr: "" });

    await expect(
      assertCodexCredentialsLaunchable({
        runId: "run-probe-timeout",
        companyId: "company-1",
        configuredCodexHome: managedAgentHome,
        configuredApiKey: null,
        effectiveCodexHome: managedAgentHome,
        target: sandboxTarget,
        cwd: "/workspace",
        env,
        onLog: async () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps the strict host requirement for non-sandbox targets", async () => {
    const { env, managedAgentHome } = await makeCredentiallessManagedHome();

    await expect(
      assertCodexCredentialsLaunchable({
        runId: "run-local",
        companyId: "company-1",
        configuredCodexHome: managedAgentHome,
        configuredApiKey: null,
        effectiveCodexHome: managedAgentHome,
        target: undefined,
        cwd: "/workspace",
        env,
        onLog: async () => {},
      }),
    ).rejects.toThrow(/Sign in to Codex on the host/);
    expect(mockRunTargetShellCommand).not.toHaveBeenCalled();
  });

  it("does not gate at all when a per-agent OPENAI_API_KEY is configured", async () => {
    const { env, managedAgentHome } = await makeCredentiallessManagedHome();

    await expect(
      assertCodexCredentialsLaunchable({
        runId: "run-api-key",
        companyId: "company-1",
        configuredCodexHome: managedAgentHome,
        configuredApiKey: "sk-agent",
        effectiveCodexHome: managedAgentHome,
        target: sandboxTarget,
        cwd: "/workspace",
        env,
        onLog: async () => {},
      }),
    ).resolves.toBeUndefined();
    expect(mockRunTargetShellCommand).not.toHaveBeenCalled();
  });
});

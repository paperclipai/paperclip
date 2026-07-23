import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  buildClaudeAcpConfig,
  createClaudeAcpExecutor,
  nodeVersionMeetsClaudeAcpMinimum,
  resolveClaudeAcpBillingIdentity,
  resolveClaudeExecutionEngine,
  resolveClaudeExecutionEngineForRun,
  testClaudeAcpEnvironment,
} from "./acp.js";

// A local stand-in for a sandbox runner: runs the managed-runtime staging
// scripts (mkdir/tar/find) as real child processes so the remote ACP lane can
// be exercised end-to-end against the host filesystem.
function createLocalSandboxRunner() {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    }) => {
      counter += 1;
      const command = input.command === "bash" ? "/bin/bash" : input.command;
      return await runChildProcess(`claude-acp-sandbox-run-${counter}`, command, input.args ?? [], {
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
      });
    },
  };
}

type FakeRuntimeOptions = Record<string, unknown>;
type FakeRuntimeEvent = { type: string; text?: string; stream?: string; tag?: string };
type FakeRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string;
  cwd?: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
};
type FakeRuntimeTurnResult = { status: "completed" | "failed" | "cancelled"; stopReason?: string };
type FakeRuntimeTurn = {
  requestId: string;
  events: AsyncIterable<FakeRuntimeEvent>;
  result: Promise<FakeRuntimeTurnResult>;
  cancel: () => Promise<void>;
  closeStream: () => Promise<void>;
};

const tempRoots: string[] = [];
const originalNodeVersion = process.version;
const originalEnv: Record<string, string | undefined> = {
  PAPERCLIP_HOME: process.env.PAPERCLIP_HOME,
  PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(async () => {
  setNodeVersion(originalNodeVersion);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class FakeRuntime {
  ensureInputs: Array<{
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
  }> = [];
  startInputs: Array<{ handle: FakeRuntimeHandle; text: string; requestId: string; timeoutMs?: number }> = [];
  closeInputs: Array<{ handle: FakeRuntimeHandle; reason: string; discardPersistentState?: boolean }> = [];
  setConfigInputs: Array<{ handle: FakeRuntimeHandle; key: string; value: string }> = [];
  ensureCount = 0;

  constructor(
    readonly options: FakeRuntimeOptions,
    readonly events: FakeRuntimeEvent[] = [
      { type: "text_delta", text: "hello", stream: "output", tag: "agent_message_chunk" },
    ],
    readonly terminal: FakeRuntimeTurnResult = { status: "completed", stopReason: "end_turn" },
  ) {}

  async ensureSession(input: {
    sessionKey: string;
    agent: string;
    mode: "persistent" | "oneshot";
    cwd?: string;
    resumeSessionId?: string;
  }): Promise<FakeRuntimeHandle> {
    this.ensureInputs.push(input);
    this.ensureCount += 1;
    return {
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `runtime-${this.ensureCount}`,
      cwd: input.cwd,
      acpxRecordId: `record-${this.ensureCount}`,
      backendSessionId: `acp-${this.ensureCount}`,
      agentSessionId: `agent-${this.ensureCount}`,
    };
  }

  startTurn(input: {
    handle: FakeRuntimeHandle;
    text: string;
    requestId: string;
    timeoutMs?: number;
  }): FakeRuntimeTurn {
    this.startInputs.push(input);
    const events = this.events;
    const terminal = this.terminal;
    return {
      requestId: input.requestId,
      events: {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) yield event;
        },
      },
      result: Promise.resolve(terminal),
      cancel: async () => {},
      closeStream: async () => {},
    };
  }

  runTurn(): AsyncIterable<FakeRuntimeEvent> {
    throw new Error("not used");
  }

  getCapabilities() {
    return { controls: [] };
  }

  getStatus() {
    return Promise.resolve({});
  }

  async setConfigOption(input: { handle: FakeRuntimeHandle; key: string; value: string }) {
    this.setConfigInputs.push(input);
  }

  async setMode() {}

  async cancel() {}

  async close(input: { handle: FakeRuntimeHandle; reason: string; discardPersistentState?: boolean }) {
    this.closeInputs.push(input);
  }
}

async function makeTempRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function createRuntimeSkill(root: string) {
  const source = path.join(root, "skills", "review");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), "---\n---\nUse the review skill.\n", "utf8");
  return {
    key: "company/review",
    runtimeName: "review",
    source,
  };
}

function buildContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude ACP",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "PAP-1",
    },
    config: {
      engine: "acp",
      cwd: root,
      stateDir: path.join(root, "state"),
      promptTemplate: "Do the assigned work.",
    },
    context: {
      issueId: "issue-1",
      paperclipTaskMarkdown: "Task context",
      paperclipWorkspace: {
        cwd: root,
        source: "project_workspace",
        workspaceId: "workspace-1",
      },
    },
    onLog: async () => {},
    ...overrides,
  };
}

describe("claude_local ACP lane", () => {
  it("maps Claude config to the ACPX Claude target", () => {
    expect(buildClaudeAcpConfig({
      engine: "acp",
      cwd: "/repo",
      model: "claude-opus-4-7",
      effort: "high",
      agentCommand: "custom-claude-acp",
      warmHandleIdleMs: 25,
    })).toMatchObject({
      agent: "claude",
      cwd: "/repo",
      model: "claude-opus-4-7",
      effort: "high",
      agentCommand: "custom-claude-acp",
      mode: "persistent",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      warmHandleIdleMs: 25,
    });
  });

  it("checks the Node version required by the Claude ACP runtime", () => {
    setNodeVersion("v22.11.0");
    expect(nodeVersionMeetsClaudeAcpMinimum()).toBe(false);
    setNodeVersion("v22.12.0");
    expect(nodeVersionMeetsClaudeAcpMinimum()).toBe(true);
  });

  it("defaults to ACP when prerequisites pass and falls back to CLI only for auto resolution", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-default-");
    const commandPath = path.join(root, "bin", "claude-agent-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.12.0");

    expect(resolveClaudeExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "cli", agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: true });

    setNodeVersion("v22.11.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("Node"),
    });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", agentCommand: "/missing/claude-agent-acp" },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: true });
  });

  it("selects the confined CLI lane for local filesystem or network scope", async () => {
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("spawn-level confinement"),
    });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { engine: "acp", filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).rejects.toThrow("ACP confinement is not supported");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { networkScope: "deny" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("network scope"),
    });
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { networkScope: "public" },
        executionTarget: null,
      }),
    ).rejects.toThrow('networkScope must be "deny" or "allowlist"');
  });

  it("uses ACP for bridged sandbox auto runs when the ACP command is configured as a shell command", async () => {
    setNodeVersion("v22.12.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: "claude-agent-acp" },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
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
        },
      }),
    ).resolves.toEqual({ engine: "acp", explicit: false });
  });

  it("falls back to the CLI lane for one-shot sandbox auto runs", async () => {
    setNodeVersion("v22.12.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: {},
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
        },
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("bidirectional remote process"),
    });
  });

  it("falls back to the CLI lane for non-sandbox remote auto runs", async () => {
    setNodeVersion("v22.12.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: {},
        executionTarget: {
          kind: "remote",
          transport: "ssh",
          remoteCwd: "/work",
          spec: {
            host: "127.0.0.1",
            port: 22,
            username: "fixture",
            remoteCwd: "/work",
            remoteWorkspacePath: "/work",
            privateKey: null,
            knownHosts: null,
            strictHostKeyChecking: true,
          },
        },
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("sandbox remote targets only"),
    });
  });

  it("reports ACP prerequisites for the ACP lane", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-env-");
    const commandPath = path.join(root, "bin", "claude-agent-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.12.0");

    const result = await testClaudeAcpEnvironment({
      adapterType: "claude_local",
      companyId: "company-1",
      config: {
        engine: "acp",
        cwd: root,
        agentCommand: commandPath,
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_engine_selected",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_acp_command_resolvable",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "claude_acp_runtime_scaffold",
        level: "info",
      }),
    );
  });

  it("executes through ACPX with Claude model env, settings.local.json, and ephemeral skills", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-exec-");
    const skill = await createRuntimeSkill(root);
    const runtimes: FakeRuntime[] = [];
    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(buildContext(root, {
      config: {
        engine: "acp",
        cwd: root,
        stateDir: path.join(root, "state"),
        model: "claude-opus-4-7",
        effort: "high",
        promptTemplate: "Do the assigned work.",
        paperclipRuntimeSkills: [skill],
        paperclipSkillSync: { desiredSkills: [skill.key] },
      },
      onMeta: async (payload: AdapterInvocationMeta) => {
        meta.push(payload);
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toMatchObject({
      agent: "claude",
      mode: "persistent",
      acpSessionId: "acp-1",
      workspaceId: "workspace-1",
    });
    expect(result.sessionParams?.skills).toMatchObject({
      mode: "claude",
      selectedSkills: ["review"],
    });
    const skillRoot = (result.sessionParams?.skills as { skillRoot?: string }).skillRoot;
    expect(skillRoot).toBeTruthy();
    await expect(fs.readFile(path.join(skillRoot!, "review", "SKILL.md"), "utf8")).resolves.toContain("review skill");
    expect(runtimes[0]?.setConfigInputs.map((input) => [input.key, input.value])).toEqual([["effort", "high"]]);
    expect(meta[0]?.commandNotes?.join("\n")).toContain("set via ANTHROPIC_MODEL");
    expect(meta[0]?.env?.ANTHROPIC_MODEL).toBe("claude-opus-4-7");
    const settings = JSON.parse(await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
    expect(settings.permissions.defaultMode).toBe("default");
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(["Bash(curl:*)", "Bash(env)"]));
  });

  it("creates the ACP session on the in-sandbox workspace cwd for runner-backed remote runs", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-remote-cwd-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");

    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          // Throwaway ACP command so the process-session bridge does not require
          // a real claude-agent-acp binary in the local sandbox stand-in.
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
        },
        context: {
          issueId: "issue-1",
          paperclipTaskMarkdown: "Task context",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
      }),
    );

    expect(result.exitCode).toBe(0);
    await expect(fs.readFile(path.join(remoteCwd, "hello.txt"), "utf8")).resolves.toBe("hi");
    expect(runtimes[0]?.ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(runtimes[0]?.ensureInputs[0]?.cwd).not.toBe(localCwd);
  });

  it("seeds the managed Claude config into the sandbox and repoints CLAUDE_CONFIG_DIR to the in-sandbox path", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-home-seed-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sharedClaudeConfig = path.join(root, "shared-claude-config");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sharedClaudeConfig, { recursive: true });
    // Host shared Claude config the seed is built from.
    await fs.writeFile(
      path.join(sharedClaudeConfig, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      "utf8",
    );
    await fs.writeFile(path.join(sharedClaudeConfig, "CLAUDE.md"), "# shared guidance\n", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfig;

    const meta: AdapterInvocationMeta[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
        onMeta: async (payload: AdapterInvocationMeta) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const remappedConfigDir = String(meta[0]?.env?.CLAUDE_CONFIG_DIR ?? "");
    // C2 — CLAUDE_CONFIG_DIR repointed onto an in-sandbox path, distinct from the
    // host shared config dir.
    expect(remappedConfigDir).not.toBe(sharedClaudeConfig);
    expect(remappedConfigDir).toContain(".paperclip-runtime");
    expect(remappedConfigDir.endsWith("/config")).toBe(true);
    // Seeded: settings.json was materialized into the in-sandbox config dir (the
    // local runner uses the host FS, so this is a real host path).
    await expect(fs.readFile(path.join(remappedConfigDir, "settings.json"), "utf8")).resolves.toContain(
      "permissions",
    );
    // C4 — no XDG_* variable is introduced for in-sandbox credential discovery.
    expect(Object.keys(meta[0]?.env ?? {}).filter((key) => key.startsWith("XDG_"))).toEqual([]);
  });

  it("remaps a workspace-relative explicit CLAUDE_CONFIG_DIR onto the in-sandbox workspace path", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-explicit-inworkspace-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    // Operator pins a config dir that lives INSIDE the workspace cwd, so it is
    // staged into the sandbox and its host prefix must be remapped onto the
    // in-sandbox workspace dir (never forwarded as the host path).
    const operatorConfigDir = path.join(localCwd, ".claude-config");
    await fs.mkdir(operatorConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(operatorConfigDir, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      "utf8",
    );
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";

    const meta: AdapterInvocationMeta[] = [];
    const logs: string[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          env: { CLAUDE_CONFIG_DIR: operatorConfigDir },
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
          logs.push(chunk);
        },
        onMeta: async (payload: AdapterInvocationMeta) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    // Prefix remapped host→sandbox: same relative subpath, in-sandbox workspace root.
    expect(meta[0]?.env?.CLAUDE_CONFIG_DIR).toBe(path.posix.join(remoteCwd, ".claude-config"));
    expect(meta[0]?.env?.CLAUDE_CONFIG_DIR).not.toBe(operatorConfigDir);
    // No managed config seed is materialized — the operator dir is authoritative.
    expect(String(meta[0]?.env?.CLAUDE_CONFIG_DIR ?? "")).not.toContain(".paperclip-runtime");
    expect(logs.join("")).toContain(
      `Remapped operator CLAUDE_CONFIG_DIR from host path ${operatorConfigDir}`,
    );
  });

  it("ignores a host-only explicit CLAUDE_CONFIG_DIR that cannot reach the sandbox and seeds the managed config instead", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-explicit-hostonly-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sharedClaudeConfig = path.join(root, "shared-claude-config");
    // An operator-pinned config dir OUTSIDE the workspace cwd: a host-only path the
    // sandbox cannot reach, so it must not be forwarded verbatim.
    const operatorConfigDir = path.join(root, "operator-claude-config");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sharedClaudeConfig, { recursive: true });
    // Host shared Claude config the managed seed is built from.
    await fs.writeFile(
      path.join(sharedClaudeConfig, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
      "utf8",
    );
    await fs.writeFile(path.join(sharedClaudeConfig, "CLAUDE.md"), "# shared guidance\n", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";
    process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfig;

    const meta: AdapterInvocationMeta[] = [];
    const logs: string[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          // Explicit user-managed CLAUDE_CONFIG_DIR (adapter config env, not a host
          // env leak) pointing at a host-only path.
          env: { CLAUDE_CONFIG_DIR: operatorConfigDir },
        },
        context: {
          issueId: "issue-1",
          paperclipWorkspace: { cwd: localCwd, source: "project_workspace", workspaceId: "workspace-1" },
        },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner: createLocalSandboxRunner(),
        } as never,
        authToken: "real-run-jwt",
        onLog: async (_stream: "stdout" | "stderr", chunk: string) => {
          logs.push(chunk);
        },
        onMeta: async (payload: AdapterInvocationMeta) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const remappedConfigDir = String(meta[0]?.env?.CLAUDE_CONFIG_DIR ?? "");
    // The un-portable host path is dropped; managed config is seeded in-sandbox.
    expect(remappedConfigDir).not.toBe(operatorConfigDir);
    expect(remappedConfigDir).toContain(".paperclip-runtime");
    expect(remappedConfigDir.endsWith("/config")).toBe(true);
    await expect(fs.readFile(path.join(remappedConfigDir, "settings.json"), "utf8")).resolves.toContain(
      "permissions",
    );
    // Observability: the un-portable override is flagged so the substitution is diagnosable.
    expect(logs.join("")).toContain(
      `operator-provided CLAUDE_CONFIG_DIR=${operatorConfigDir} is outside the staged workspace`,
    );
  });

  it("falls back to the CLI lane for a runner-less sandbox even when the ACP command is set", async () => {
    setNodeVersion("v22.13.0");
    await expect(
      resolveClaudeExecutionEngineForRun({
        config: { agentCommand: "claude-agent-acp" },
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd: "/work",
        },
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("bidirectional remote process"),
    });
  });

  it("resumes compatible ACP sessions on later Claude ACP runs", async () => {
    const root = await makeTempRoot("paperclip-claude-acp-resume-");
    const runtimes: FakeRuntime[] = [];
    const execute = createClaudeAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => {
        const runtime = new FakeRuntime(options);
        runtimes.push(runtime);
        return runtime as never;
      },
    });

    const first = await execute(buildContext(root));
    const second = await execute(buildContext(root, {
      runtime: {
        sessionId: first.sessionId ?? null,
        sessionParams: first.sessionParams ?? null,
        sessionDisplayId: first.sessionDisplayId ?? null,
        taskKey: "PAP-1",
      },
    }));

    expect(second.exitCode).toBe(0);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]?.ensureInputs[0]?.resumeSessionId).toBe("acp-1");
  });
});

describe("resolveClaudeAcpBillingIdentity", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const originalBedrockBase = process.env.ANTHROPIC_BEDROCK_BASE_URL;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock;
    if (originalBedrockBase === undefined) delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    else process.env.ANTHROPIC_BEDROCK_BASE_URL = originalBedrockBase;
  });

  it("classifies an adapter-config API key as api billing", () => {
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { ANTHROPIC_API_KEY: "sk-ant-test" } } }),
    ).toEqual({ provider: "anthropic", biller: "anthropic", billingType: "api" });
  });

  it("classifies Bedrock auth as metered_api billed to aws_bedrock", () => {
    expect(
      resolveClaudeAcpBillingIdentity({ config: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } } }),
    ).toEqual({ provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" });
  });

  it("falls back to subscription without API-key or Bedrock auth", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    expect(resolveClaudeAcpBillingIdentity({ config: {} })).toEqual({
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription",
    });
  });

  it("ignores host env for remote execution targets", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-only";
    expect(
      resolveClaudeAcpBillingIdentity({
        config: {},
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
      } as never).billingType,
    ).toBe("subscription");
  });
});

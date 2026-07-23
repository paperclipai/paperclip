import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  buildCodexAcpConfig,
  createCodexAcpExecutor,
  nodeVersionMeetsCodexAcpMinimum,
  resolveCodexAcpBillingIdentity,
  resolveCodexExecutionEngine,
  resolveCodexExecutionEngineForRun,
  testCodexAcpEnvironment,
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
      return await runChildProcess(`codex-acp-sandbox-run-${counter}`, command, input.args ?? [], {
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
const originalPaperclipHome = process.env.PAPERCLIP_HOME;
const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
const originalCodexHome = process.env.CODEX_HOME;

// Older/newer ISO timestamps for the copy-back monotonic (strictly-newer)
// decision predicate, plus a subscription-shaped auth.json fixture matching the
// predicate's parseAuth contract (tokens.account_id + token material +
// last_refresh).
const OLDER_REFRESH = "2026-01-01T00:00:00.000Z";
const NEWER_REFRESH = "2026-06-01T00:00:00.000Z";

function subscriptionAuthJson(accountId: string, lastRefresh: string, marker: string): string {
  return JSON.stringify(
    {
      tokens: {
        id_token: `id-${marker}`,
        access_token: `acc-${marker}`,
        refresh_token: `ref-${marker}`,
        account_id: accountId,
      },
      last_refresh: lastRefresh,
    },
    null,
    2,
  );
}

// Enumerate the host staged-home temp dirs `stageCodexHomeForSync` created for a
// given runId (`paperclip-codex-home-sync-<runId>-<random>` under os.tmpdir()).
// A unique per-test runId scopes the match to this run's staging dirs only, so
// the assertion is not disturbed by other tests/processes sharing the tmp dir.
async function listCodexHomeSyncDirs(runId: string): Promise<string[]> {
  const prefix = `paperclip-codex-home-sync-${runId}-`;
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((name) => name.startsWith(prefix)).map((name) => path.join(os.tmpdir(), name));
}

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(async () => {
  setNodeVersion(originalNodeVersion);
  if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalPaperclipHome;
  if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
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
  process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
  process.env.PAPERCLIP_INSTANCE_ID = "test";
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
      name: "Codex ACP",
      adapterType: "codex_local",
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
      env: {
        CODEX_HOME: path.join(root, "codex-home"),
      },
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

describe("codex_local ACP lane", () => {
  it("defaults to ACP when prerequisites pass and falls back to CLI only for auto resolution", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-default-");
    const commandPath = path.join(root, "bin", "codex-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.13.0");

    expect(resolveCodexExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { engine: "cli", agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: true });
    expect(resolveCodexExecutionEngine({ engine: "acp" })).toEqual({
      engine: "acp",
      explicit: true,
    });

    setNodeVersion("v22.12.0");
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { agentCommand: commandPath },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("Node"),
    });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { engine: "acp", agentCommand: "/missing/codex-acp" },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: true });
  });

  it("selects the confined CLI lane for local filesystem or network scope", async () => {
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("spawn-level confinement"),
    });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { engine: "acp", filesystemScope: "workspace" },
        executionTarget: null,
      }),
    ).rejects.toThrow("ACP confinement is not supported");
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { networkScope: "allowlist" },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("network scope"),
    });
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { filesystemScope: "workpace" },
        executionTarget: null,
      }),
    ).rejects.toThrow('filesystemScope must be "workspace"');
  });

  it("uses ACP for bridged sandbox auto runs when the ACP command is configured as a shell command", async () => {
    setNodeVersion("v22.13.0");
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { agentCommand: "codex-acp" },
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
    setNodeVersion("v22.13.0");
    await expect(
      resolveCodexExecutionEngineForRun({
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
    setNodeVersion("v22.13.0");
    await expect(
      resolveCodexExecutionEngineForRun({
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

  it("maps Codex config to the ACPX Codex target", () => {
    expect(buildCodexAcpConfig({
      engine: "acp",
      cwd: "/repo",
      command: "codex",
      model: "gpt-5.5",
      modelReasoningEffort: "high",
      fastMode: true,
      agentCommand: "custom-codex-acp",
      warmHandleIdleMs: 25,
    })).toMatchObject({
      agent: "codex",
      cwd: "/repo",
      command: "codex",
      model: "gpt-5.5",
      modelReasoningEffort: "high",
      fastMode: true,
      agentCommand: "custom-codex-acp",
      mode: "persistent",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      warmHandleIdleMs: 25,
    });
  });

  it("checks the Node version required by the ACPX runtime", () => {
    setNodeVersion("v22.12.0");
    expect(nodeVersionMeetsCodexAcpMinimum()).toBe(false);
    setNodeVersion("v22.13.0");
    expect(nodeVersionMeetsCodexAcpMinimum()).toBe(true);
  });

  it("reports ACP prerequisites for the ACP lane", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-env-");
    const commandPath = path.join(root, "bin", "codex-acp");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v22.13.0");

    const result = await testCodexAcpEnvironment({
      adapterType: "codex_local",
      companyId: "company-1",
      config: {
        engine: "acp",
        cwd: root,
        agentCommand: commandPath,
        env: { OPENAI_API_KEY: "test-key" },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_engine_selected",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_acp_command_resolvable",
        level: "info",
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "codex_acp_runtime_scaffold",
        level: "info",
      }),
    );
  });

  it("executes through ACPX with Codex session config and ephemeral skills", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-exec-");
    const skill = await createRuntimeSkill(root);
    const runtimes: FakeRuntime[] = [];
    const meta: AdapterInvocationMeta[] = [];
    const execute = createCodexAcpExecutor({
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
        env: {
          CODEX_HOME: path.join(root, "codex-home"),
        },
        model: "gpt-5.5",
        modelReasoningEffort: "high",
        fastMode: true,
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
      agent: "codex",
      mode: "persistent",
      acpSessionId: "acp-1",
      workspaceId: "workspace-1",
    });
    expect(result.sessionParams?.skills).toMatchObject({
      mode: "codex",
      selectedSkills: ["review"],
    });
    const skillsHome = (result.sessionParams?.skills as { skillsHome?: string }).skillsHome;
    expect(skillsHome).toBeTruthy();
    await expect(fs.readFile(path.join(skillsHome!, "review", "SKILL.md"), "utf8")).resolves.toContain("review skill");
    expect(runtimes[0]?.ensureInputs[0]).toMatchObject({
      agent: "codex",
      mode: "persistent",
      cwd: root,
    });
    expect(runtimes[0]?.setConfigInputs).toEqual([]);
    expect(meta[0]?.commandNotes?.join("\n")).toContain("Prepared ACPX Codex skill home");
    expect(meta[0]?.env?.CODEX_HOME).toBe(path.join(root, "codex-home"));
    expect(JSON.parse(String(meta[0]?.env?.CODEX_CONFIG))).toEqual({
      model: "gpt-5.5",
      model_reasoning_effort: "high",
      service_tier: "fast",
      features: { fast_mode: true },
    });
  });

  it("creates the ACP session on the in-sandbox workspace cwd for runner-backed remote runs", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-remote-cwd-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");

    const runtimes: FakeRuntime[] = [];
    const execute = createCodexAcpExecutor({
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
          // Use a throwaway ACP command so the process-session bridge does not
          // require a real codex-acp binary in the local sandbox stand-in.
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          env: { CODEX_HOME: path.join(root, "codex-home") },
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
    // The workspace was shipped into the sandbox and session/new was created on
    // the in-sandbox workspace dir — not the HOST worktree path.
    await expect(fs.readFile(path.join(remoteCwd, "hello.txt"), "utf8")).resolves.toBe("hi");
    expect(runtimes[0]?.ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(runtimes[0]?.ensureInputs[0]?.cwd).not.toBe(localCwd);
  });

  it("seeds the managed Codex home into the sandbox and repoints CODEX_HOME to the in-sandbox path", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-home-seed-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sourceHome = path.join(root, "codex-home");
    // A separate shared host home with no auth.json so the teardown copy-back is
    // a benign no-op here (this test asserts the inbound seed + remap only).
    const sharedHostHome = path.join(root, "shared-codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(sharedHostHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceHome, "auth.json"),
      subscriptionAuthJson("acct-seed", NEWER_REFRESH, "seed"),
      { mode: 0o600 },
    );
    process.env.CODEX_HOME = sharedHostHome;

    const meta: AdapterInvocationMeta[] = [];
    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          env: { CODEX_HOME: sourceHome },
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
    const remappedCodexHome = String(meta[0]?.env?.CODEX_HOME ?? "");
    // C2 — the managed home was repointed onto an in-sandbox path, distinct from
    // the host managed home; it is NOT the host CODEX_HOME.
    expect(remappedCodexHome).not.toBe(sourceHome);
    expect(remappedCodexHome).not.toBe(sharedHostHome);
    expect(remappedCodexHome).toContain(".paperclip-runtime");
    // Seeded: the credential materialized into the in-sandbox home (the local
    // runner uses the host FS, so the in-sandbox path is a real host path).
    await expect(fs.readFile(path.join(remappedCodexHome, "auth.json"), "utf8")).resolves.toContain(
      "account_id",
    );
    // C4 — no XDG_* variable is introduced for in-sandbox credential discovery.
    expect(Object.keys(meta[0]?.env ?? {}).filter((key) => key.startsWith("XDG_"))).toEqual([]);
  });

  it("copies a strictly-newer sandbox Codex auth back to the shared host on teardown", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-copyback-newer-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sourceHome = path.join(root, "codex-home");
    const sharedHostHome = path.join(root, "shared-codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(sharedHostHome, { recursive: true });
    // The home staged into the sandbox carries a strictly-newer, same-identity
    // credential (simulating an in-sandbox token rotation); the shared host copy
    // is older.
    await fs.writeFile(
      path.join(sourceHome, "auth.json"),
      subscriptionAuthJson("acct-same", NEWER_REFRESH, "sandbox-newer"),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(sharedHostHome, "auth.json"),
      subscriptionAuthJson("acct-same", OLDER_REFRESH, "host-older"),
      { mode: 0o600 },
    );
    process.env.CODEX_HOME = sharedHostHome;

    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          env: { CODEX_HOME: sourceHome },
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
      }),
    );

    expect(result.exitCode).toBe(0);
    // C5 — copy-back fired on teardown and installed the strictly-newer sandbox
    // credential onto the shared host under the merge-lock / monotonic guard.
    const hostAuth = JSON.parse(await fs.readFile(path.join(sharedHostHome, "auth.json"), "utf8"));
    expect(hostAuth.last_refresh).toBe(NEWER_REFRESH);
    expect(hostAuth.tokens.refresh_token).toBe("ref-sandbox-newer");
    // Mode preserved at 0600 by the atomic same-directory rename.
    const mode = (await fs.stat(path.join(sharedHostHome, "auth.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps the shared host Codex auth when the sandbox copy is not strictly newer", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-copyback-older-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sourceHome = path.join(root, "codex-home");
    const sharedHostHome = path.join(root, "shared-codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(sharedHostHome, { recursive: true });
    // The staged/sandbox credential is OLDER than the shared host copy: the
    // strictly-newer guard must keep the host credential (never overwrite a good
    // token with a spent one).
    await fs.writeFile(
      path.join(sourceHome, "auth.json"),
      subscriptionAuthJson("acct-same", OLDER_REFRESH, "sandbox-older"),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(sharedHostHome, "auth.json"),
      subscriptionAuthJson("acct-same", NEWER_REFRESH, "host-newer"),
      { mode: 0o600 },
    );
    process.env.CODEX_HOME = sharedHostHome;

    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
    });
    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          env: { CODEX_HOME: sourceHome },
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
      }),
    );

    expect(result.exitCode).toBe(0);
    const hostAuth = JSON.parse(await fs.readFile(path.join(sharedHostHome, "auth.json"), "utf8"));
    expect(hostAuth.last_refresh).toBe(NEWER_REFRESH);
    expect(hostAuth.tokens.refresh_token).toBe("ref-host-newer");
  });

  it("keeps the host staged Codex home after a clean teardown so a compatible resume can reuse it", async () => {
    // Session-re-staging guardrail: the per-run copy-back (`teardown`) must NOT
    // remove the host staged-home temp dir — that removal moved to the one-time
    // `disposeStaged`, fired only when the runtime is dropped. So after a CLEAN
    // turn the engine caches the staged runtime warm and its host staged home is
    // still on disk for the next compatible resume to reuse.
    const runId = "run-keep-staged-home";
    const root = await makeTempRoot("paperclip-codex-acp-keep-staged-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sourceHome = path.join(root, "codex-home");
    const sharedHostHome = path.join(root, "shared-codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(sharedHostHome, { recursive: true });
    // Strictly-newer sandbox credential so the per-run copy-back has real work.
    await fs.writeFile(
      path.join(sourceHome, "auth.json"),
      subscriptionAuthJson("acct-same", NEWER_REFRESH, "sandbox-newer"),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(sharedHostHome, "auth.json"),
      subscriptionAuthJson("acct-same", OLDER_REFRESH, "host-older"),
      { mode: 0o600 },
    );
    process.env.CODEX_HOME = sharedHostHome;

    // Isolated staged-runtime cache so this test observes only its own entry.
    const stagedRuntimes = new Map();
    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(options) as never,
      stagedRuntimes,
      stagingLocks: new Map(),
    });
    const result = await execute(
      buildContext(localCwd, {
        runId,
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          env: { CODEX_HOME: sourceHome },
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
      }),
    );

    expect(result.exitCode).toBe(0);
    // Guardrail: `teardown` ran the copy-back but left the host staged home in
    // place, and the clean turn cached the staged runtime warm for reuse.
    const stagedDirs = await listCodexHomeSyncDirs(runId);
    expect(stagedDirs).toHaveLength(1);
    await expect(fs.stat(stagedDirs[0]!)).resolves.toBeDefined();
    expect(stagedRuntimes.size).toBe(1);
    // The per-run copy-back still fired: the strictly-newer sandbox credential
    // landed on the shared host under the monotonic guard.
    const hostAuth = JSON.parse(await fs.readFile(path.join(sharedHostHome, "auth.json"), "utf8"));
    expect(hostAuth.last_refresh).toBe(NEWER_REFRESH);
    expect(hostAuth.tokens.refresh_token).toBe("ref-sandbox-newer");
    // No `disposeStaged` fires while the entry stays warm, so remove the
    // intentionally-persisted staged temp ourselves to avoid leaking it.
    await Promise.all(stagedDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("removes the host staged Codex home when a failed turn drops the staged runtime", async () => {
    // The complementary guardrail: when the staged runtime IS dropped (here, a
    // failed turn), the one-time `disposeStaged` fires and removes the host
    // staged-home temp dir — while the per-run copy-back (`teardown`) STILL fires
    // on the unclean exit path, so a rotated sandbox credential is never lost.
    const runId = "run-drop-staged-home";
    const root = await makeTempRoot("paperclip-codex-acp-drop-staged-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const sourceHome = path.join(root, "codex-home");
    const sharedHostHome = path.join(root, "shared-codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(sharedHostHome, { recursive: true });
    await fs.writeFile(
      path.join(sourceHome, "auth.json"),
      subscriptionAuthJson("acct-same", NEWER_REFRESH, "sandbox-newer"),
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(sharedHostHome, "auth.json"),
      subscriptionAuthJson("acct-same", OLDER_REFRESH, "host-older"),
      { mode: 0o600 },
    );
    process.env.CODEX_HOME = sharedHostHome;

    const stagedRuntimes = new Map();
    const execute = createCodexAcpExecutor({
      // A failed turn drives the drop path (discard staged runtime + dispose).
      createRuntime: (options: FakeRuntimeOptions) =>
        new FakeRuntime(options, [], { status: "failed", stopReason: "error" }) as never,
      stagedRuntimes,
      stagingLocks: new Map(),
    });
    const result = await execute(
      buildContext(localCwd, {
        runId,
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          env: { CODEX_HOME: sourceHome },
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
      }),
    );

    expect(result.exitCode).toBe(1);
    // Guardrail: the dropped staged runtime disposed its host staged home and
    // left nothing cached for reuse.
    await expect(listCodexHomeSyncDirs(runId)).resolves.toEqual([]);
    expect(stagedRuntimes.size).toBe(0);
    // ...yet the per-run copy-back still ran on the failure teardown path, so the
    // strictly-newer sandbox credential was not lost.
    const hostAuth = JSON.parse(await fs.readFile(path.join(sharedHostHome, "auth.json"), "utf8"));
    expect(hostAuth.last_refresh).toBe(NEWER_REFRESH);
    expect(hostAuth.tokens.refresh_token).toBe("ref-sandbox-newer");
  });

  it("falls back to the CLI lane for a runner-less sandbox even when the ACP command is set", async () => {
    setNodeVersion("v22.13.0");
    // Isolate the missing bidirectional runner as the sole fallback cause:
    // provide a valid ACP command and Node version so the only difference from
    // the runner-backed ACP case is the absent `runner`.
    await expect(
      resolveCodexExecutionEngineForRun({
        config: { agentCommand: "codex-acp" },
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

  it("classifies ACP refresh-token auth failures", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-refresh-token-");
    const execute = createCodexAcpExecutor({
      createRuntime: (options: FakeRuntimeOptions) => new FakeRuntime(
        options,
        [],
        {
          status: "failed",
          error: { message: "OAuth failed: refresh_token_invalidated" },
        } as unknown as FakeRuntimeTurnResult,
      ) as never,
    });

    const result = await execute(buildContext(root));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("refresh_token_invalidated");
    expect(result.errorFamily).toBe("refresh_token_invalidated");
    expect(result.resultJson?.errorFamily).toBe("refresh_token_invalidated");
    expect(result.resultJson).not.toHaveProperty("codexCredentialTelemetry");
  });

  it("resumes compatible ACP sessions on later Codex ACP runs", async () => {
    const root = await makeTempRoot("paperclip-codex-acp-resume-");
    const runtimes: FakeRuntime[] = [];
    const execute = createCodexAcpExecutor({
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

describe("resolveCodexAcpBillingIdentity", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  });

  it("classifies an adapter-config API key as api billing to openai", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(
      resolveCodexAcpBillingIdentity({ config: { env: { OPENAI_API_KEY: "sk-test" } } }),
    ).toEqual({ provider: "openai", biller: "openai", billingType: "api" });
  });

  it("falls back to chatgpt subscription without an API key", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(resolveCodexAcpBillingIdentity({ config: {} })).toEqual({
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription",
    });
  });

  it("bills OpenRouter-backed runs to openrouter", () => {
    expect(
      resolveCodexAcpBillingIdentity({
        config: { env: { OPENAI_API_KEY: "sk-test", OPENROUTER_API_KEY: "or-test" } },
      }),
    ).toEqual({ provider: "openai", biller: "openrouter", billingType: "api" });
  });

  it("ignores host env for remote execution targets", () => {
    process.env.OPENAI_API_KEY = "sk-host-only";
    expect(
      resolveCodexAcpBillingIdentity({
        config: {},
        executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
      } as never).billingType,
    ).toBe("subscription");
  });
});

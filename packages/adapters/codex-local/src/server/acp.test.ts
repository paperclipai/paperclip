import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import {
  buildCodexAcpConfig,
  createCodexAcpExecutor,
  nodeVersionMeetsCodexAcpMinimum,
  resolveCodexExecutionEngine,
  resolveCodexExecutionEngineForRun,
  testCodexAcpEnvironment,
} from "./acp.js";

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
    expect(runtimes[0]?.setConfigInputs.map((input) => [input.key, input.value])).toEqual([
      ["model", "gpt-5.5"],
      ["reasoning_effort", "high"],
      ["service_tier", "fast"],
      ["features.fast_mode", "true"],
    ]);
    expect(meta[0]?.commandNotes?.join("\n")).toContain("Prepared ACPX Codex skill home");
    expect(meta[0]?.env?.CODEX_HOME).toBe(path.join(root, "codex-home"));
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

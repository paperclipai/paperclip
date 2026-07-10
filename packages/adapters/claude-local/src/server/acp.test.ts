import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import {
  buildClaudeAcpConfig,
  createClaudeAcpExecutor,
  nodeVersionMeetsClaudeAcpMinimum,
  resolveClaudeExecutionEngine,
  resolveClaudeExecutionEngineForRun,
  testClaudeAcpEnvironment,
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

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(async () => {
  setNodeVersion(originalNodeVersion);
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

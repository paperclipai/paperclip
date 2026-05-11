import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createAcpxLocalExecutor } from "@paperclipai/adapter-acpx-local/server";
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeOptions,
  AcpRuntimeTurn,
  AcpRuntimeTurnResult,
} from "acpx/runtime";

type LogEntry = { stream: "stdout" | "stderr"; chunk: string };
type TestAcpRuntimeOptions = AcpRuntimeOptions & {
  sessionOptions?: {
    systemPrompt?: string | { append: string };
    additionalRoots?: string[];
  };
};

class FakeRuntime implements AcpRuntime {
  ensureInputs: Array<{ sessionKey: string; agent: string; mode: "persistent" | "oneshot"; cwd?: string; resumeSessionId?: string }> = [];
  startInputs: Array<{ handle: AcpRuntimeHandle; text: string; requestId: string; timeoutMs?: number }> = [];
  closeInputs: Array<{ handle: AcpRuntimeHandle; reason: string; discardPersistentState?: boolean }> = [];
  cancelInputs: Array<{ handle: AcpRuntimeHandle; reason?: string }> = [];
  setModeInputs: Array<{ handle: AcpRuntimeHandle; mode: string }> = [];
  setConfigInputs: Array<{ handle: AcpRuntimeHandle; key: string; value: string }> = [];
  ensureCount = 0;
  turnCount = 0;
  nextEnsureError: Error | null = null;

  constructor(
    readonly options: TestAcpRuntimeOptions,
    readonly events: AcpRuntimeEvent[] = [
      { type: "status", text: "thinking", tag: "agent_thought_chunk" },
      { type: "text_delta", text: "hello ", stream: "output", tag: "agent_message_chunk" },
      { type: "tool_call", text: "read README.md", title: "read", status: "running", toolCallId: "tool-1" },
      { type: "text_delta", text: "world", stream: "output", tag: "agent_message_chunk" },
    ],
    readonly terminal: AcpRuntimeTurnResult = { status: "completed", stopReason: "end_turn" },
  ) {}

  async ensureSession(input: { sessionKey: string; agent: string; mode: "persistent" | "oneshot"; cwd?: string; resumeSessionId?: string }): Promise<AcpRuntimeHandle> {
    this.ensureInputs.push(input);
    this.ensureCount += 1;
    if (this.nextEnsureError) {
      const err = this.nextEnsureError;
      this.nextEnsureError = null;
      throw err;
    }
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

  startTurn(input: { handle: AcpRuntimeHandle; text: string; requestId: string; timeoutMs?: number }): AcpRuntimeTurn {
    this.startInputs.push(input);
    this.turnCount += 1;
    let closed = false;
    const events = this.events;
    const terminal = this.terminal;
    const cancelInputs = this.cancelInputs;
    return {
      requestId: input.requestId,
      events: {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) {
            if (closed) return;
            yield event;
          }
        },
      },
      result: Promise.resolve(terminal),
      cancel: async (args?: { reason?: string }) => {
        cancelInputs.push({ handle: input.handle, reason: args?.reason });
        closed = true;
      },
      closeStream: async () => {
        closed = true;
      },
    };
  }

  runTurn(): AsyncIterable<AcpRuntimeEvent> {
    throw new Error("not used");
  }

  getCapabilities() {
    return { controls: [] };
  }

  getStatus() {
    return Promise.resolve({});
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }) {
    this.setModeInputs.push(input);
  }

  async setConfigOption(input: { handle: AcpRuntimeHandle; key: string; value: string }) {
    this.setConfigInputs.push(input);
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }) {
    this.cancelInputs.push(input);
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string; discardPersistentState?: boolean }) {
    this.closeInputs.push(input);
  }
}

async function createRuntimeSkill(root: string, input: {
  key?: string;
  runtimeName?: string;
  body?: string;
}) {
  const runtimeName = input.runtimeName ?? "paperclip-test-skill";
  const key = input.key ?? `company/${runtimeName}`;
  const source = path.join(root, "skills", runtimeName);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), input.body ?? "---\nrequired: false\n---\nUse the test skill.\n", "utf8");
  return {
    key,
    runtimeName,
    source,
    required: false,
  };
}

function parseStdoutLogs(logs: LogEntry[]) {
  return logs
    .filter((entry) => entry.stream === "stdout")
    .flatMap((entry) => entry.chunk.trim().split(/\n+/).filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function buildContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "ACPX Coder",
      adapterType: "acpx_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "PAP-1",
    },
    config: {
      agent: "claude",
      cwd: root,
      stateDir: path.join(root, "state"),
      promptTemplate: "Do the assigned work.",
    },
    context: {
      issueId: "issue-1",
      paperclipTaskMarkdown: "Task context",
    },
    onLog: async () => {},
    ...overrides,
  };
}

describe("acpx_local execute", () => {
  it("streams ACPX session, status, text, and tool events before returning success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-success-"));
    try {
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      const logs: LogEntry[] = [];
      let metaPermissionNote = "";
      const execute = createAcpxLocalExecutor({
        createRuntime: () => runtime,
      });
      const result = await execute(buildContext(root, {
        onLog: async (stream, chunk) => logs.push({ stream, chunk }),
        onMeta: async (meta) => {
          metaPermissionNote = meta.commandNotes?.join("\n") ?? "";
        },
      }));

      expect(result.exitCode).toBe(0);
      expect(result.summary).toBe("hello world");
      expect(result.sessionParams).toMatchObject({
        agent: "claude",
        cwd: root,
        mode: "persistent",
        acpSessionId: "acp-1",
      });
      expect(metaPermissionNote).toContain("Effective ACPX permission mode: approve-all");
      const parsed = parseStdoutLogs(logs);
      expect(parsed.map((event) => event.type)).toEqual([
        "acpx.session",
        "acpx.status",
        "acpx.text_delta",
        "acpx.tool_call",
        "acpx.text_delta",
        "acpx.result",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("closes successful persistent runs by default while retaining session state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-close-success-"));
    try {
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      const execute = createAcpxLocalExecutor({
        createRuntime: () => runtime,
      });
      const result = await execute(buildContext(root));

      expect(result.exitCode).toBe(0);
      expect(result.sessionParams).toMatchObject({
        mode: "persistent",
        acpSessionId: "acp-1",
      });
      expect(runtime.closeInputs).toEqual([
        expect.objectContaining({
          reason: "paperclip completed turn cleanup",
          discardPersistentState: false,
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies requested Codex model, reasoning effort, and fast mode before starting the turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-codex-config-"));
    try {
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      const execute = createAcpxLocalExecutor({
        createRuntime: () => runtime,
      });
      const result = await execute(buildContext(root, {
        config: {
          agent: "codex",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          model: "gpt-5.4",
          modelReasoningEffort: "xhigh",
          fastMode: true,
        },
      }));

      expect(result.exitCode).toBe(0);
      expect(result.model).toBe("gpt-5.4");
      expect(runtime.setConfigInputs).toEqual([
        expect.objectContaining({ key: "model", value: "gpt-5.4" }),
        expect.objectContaining({ key: "reasoning_effort", value: "xhigh" }),
        expect.objectContaining({ key: "service_tier", value: "fast" }),
        expect.objectContaining({ key: "features.fast_mode", value: "true" }),
      ]);
      expect(runtime.startInputs).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("logs a clear error when configured session options need unsupported runtime controls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-missing-config-controls-"));
    try {
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      Object.defineProperty(runtime, "setConfigOption", { value: undefined });
      const logs: LogEntry[] = [];
      const execute = createAcpxLocalExecutor({
        createRuntime: () => runtime,
      });
      const result = await execute(buildContext(root, {
        config: {
          agent: "codex",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          model: "gpt-5.4",
        },
        onLog: async (stream, chunk) => logs.push({ stream, chunk }),
      }));

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("does not expose session config controls");
      expect(logs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stream: "stderr",
          chunk: expect.stringContaining("upgrade ACPX or remove configured model"),
        }),
      ]));
      expect(runtime.closeInputs).toEqual([
        expect.objectContaining({
          reason: "paperclip config cleanup",
          discardPersistentState: false,
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses a compatible warm session and starts fresh when cwd changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-reuse-"));
    const other = path.join(root, "other");
    await fs.mkdir(other);
    try {
      const runtimes: FakeRuntime[] = [];
      const execute = createAcpxLocalExecutor({
        createRuntime: (options) => {
          const runtime = new FakeRuntime(options);
          runtimes.push(runtime);
          return runtime;
        },
      });
      const warmConfig = {
        agent: "claude",
        cwd: root,
        stateDir: path.join(root, "state"),
        promptTemplate: "Do the assigned work.",
        warmHandleIdleMs: 60_000,
      };

      const first = await execute(buildContext(root, { config: warmConfig }));
      const second = await execute(buildContext(root, {
        runtime: {
          sessionId: first.sessionId ?? null,
          sessionParams: first.sessionParams ?? null,
          sessionDisplayId: first.sessionDisplayId ?? null,
          taskKey: "PAP-1",
        },
        config: warmConfig,
      }));
      const third = await execute(buildContext(root, {
        runtime: {
          sessionId: first.sessionId ?? null,
          sessionParams: first.sessionParams ?? null,
          sessionDisplayId: first.sessionDisplayId ?? null,
          taskKey: "PAP-1",
        },
        config: {
          agent: "claude",
          cwd: other,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          warmHandleIdleMs: 60_000,
        },
      }));

      expect(runtimes).toHaveLength(2);
      expect(runtimes[0].ensureCount).toBe(1);
      expect(runtimes[0].turnCount).toBe(2);
      expect(runtimes[1].ensureCount).toBe(1);
      expect(second.sessionParams?.acpSessionId).toBe("acp-1");
      expect(third.sessionParams?.cwd).toBe(other);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("closes duplicate warm handles from concurrent runs for the same session key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-concurrent-"));
    try {
      const runtimes: FakeRuntime[] = [];
      const warmHandles = new Map();
      const execute = createAcpxLocalExecutor({
        warmHandles,
        createRuntime: (options) => {
          const runtime = new FakeRuntime(options);
          runtimes.push(runtime);
          return runtime;
        },
      });

      const [first, second] = await Promise.all([
        execute(buildContext(root, {
          runId: "run-1",
          config: {
            agent: "claude",
            cwd: root,
            stateDir: path.join(root, "state"),
            promptTemplate: "Do the assigned work.",
            warmHandleIdleMs: 60_000,
          },
        })),
        execute(buildContext(root, {
          runId: "run-2",
          config: {
            agent: "claude",
            cwd: root,
            stateDir: path.join(root, "state"),
            promptTemplate: "Do the assigned work.",
            warmHandleIdleMs: 60_000,
          },
        })),
      ]);

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(runtimes).toHaveLength(2);
      expect(warmHandles.size).toBe(1);
      expect(runtimes.flatMap((runtime) => runtime.closeInputs).filter((input) =>
        input.reason === "paperclip duplicate warm handle cleanup"
      )).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans configured warm handles after their idle window", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-warm-idle-"));
    vi.useFakeTimers();
    try {
      let clock = 0;
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      const warmHandles = new Map();
      const execute = createAcpxLocalExecutor({
        warmHandles,
        now: () => clock,
        createRuntime: () => runtime,
      });

      const result = await execute(buildContext(root, {
        config: {
          agent: "claude",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          warmHandleIdleMs: 1_000,
        },
      }));

      expect(result.exitCode).toBe(0);
      expect(warmHandles.size).toBe(1);
      clock = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(warmHandles.size).toBe(0);
      expect(runtime.closeInputs).toEqual([
        expect.objectContaining({
          reason: "paperclip idle cleanup",
          discardPersistentState: false,
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retries with a fresh session when ACPX cannot resume the saved backend session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-resume-"));
    try {
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      const firstExecute = createAcpxLocalExecutor({
        createRuntime: () => runtime,
        warmHandles: new Map(),
      });
      const initial = await firstExecute(buildContext(root));
      const compatibleParams = {
        ...initial.sessionParams,
        runtimeSessionName: "runtime-old",
        acpSessionId: "acp-old",
      };
      runtime.nextEnsureError = new Error("session/load failed: no session acp-old");
      const logs: LogEntry[] = [];
      const execute = createAcpxLocalExecutor({
        createRuntime: () => runtime,
        warmHandles: new Map(),
      });
      const result = await execute(buildContext(root, {
        runtime: {
          sessionId: "acp-old",
          sessionParams: compatibleParams,
          sessionDisplayId: "acp-old",
          taskKey: "PAP-1",
        },
        onLog: async (stream, chunk) => logs.push({ stream, chunk }),
      }));

      expect(result.exitCode).toBe(0);
      expect(result.clearSession).toBe(true);
      expect(runtime.ensureInputs.at(-2)?.resumeSessionId).toBe("acp-old");
      expect(runtime.ensureInputs.at(-1)?.resumeSessionId).toBeUndefined();
      expect(logs.some((entry) => entry.chunk.includes("retrying with a fresh session"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cancels and closes stale handles on timeout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-timeout-"));
    try {
      const neverFinishes = new FakeRuntime(
        {} as AcpRuntimeOptions,
        [],
        { status: "cancelled", stopReason: "cancelled" },
      );
      neverFinishes.startTurn = function (input): AcpRuntimeTurn {
        this.startInputs.push(input);
        let resolveResult!: (value: AcpRuntimeTurnResult) => void;
        const result = new Promise<AcpRuntimeTurnResult>((resolve) => {
          resolveResult = resolve;
        });
        return {
          requestId: input.requestId,
          events: {
            [Symbol.asyncIterator]: async function* () {
              await new Promise((resolve) => setTimeout(resolve, 50));
            },
          },
          result,
          cancel: async (args?: { reason?: string }) => {
            this.cancelInputs.push({ handle: input.handle, reason: args?.reason });
            resolveResult({ status: "cancelled", stopReason: args?.reason });
          },
          closeStream: async () => {},
        };
      };
      const execute = createAcpxLocalExecutor({ createRuntime: () => neverFinishes });
      const result = await execute(buildContext(root, {
        config: {
          agent: "claude",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          timeoutSec: 0.01,
        },
      }));

      expect(result.timedOut).toBe(true);
      expect(result.errorCode).toBe("acpx_timeout");
      expect(neverFinishes.cancelInputs.length).toBeGreaterThan(0);
      expect(neverFinishes.closeInputs.at(-1)?.discardPersistentState).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured auth errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-error-"));
    try {
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      runtime.nextEnsureError = new Error("authentication required: login first");
      const execute = createAcpxLocalExecutor({ createRuntime: () => runtime });
      const result = await execute(buildContext(root));
      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("acpx_auth_required");
      expect(result.errorMeta).toMatchObject({ category: "auth" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured ACP protocol errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-protocol-"));
    try {
      const runtime = new FakeRuntime({} as AcpRuntimeOptions);
      runtime.nextEnsureError = Object.assign(new Error("protocol init failed"), {
        code: "ACP_SESSION_INIT_FAILED",
      });
      const execute = createAcpxLocalExecutor({ createRuntime: () => runtime });
      const result = await execute(buildContext(root));
      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("acpx_protocol_error");
      expect(result.errorMeta).toMatchObject({
        category: "protocol",
        acpCode: "ACP_SESSION_INIT_FAILED",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("materializes selected skills for ACPX Claude and passes public session metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-claude-skills-"));
    try {
      const skill = await createRuntimeSkill(root, {});
      let runtime: FakeRuntime | null = null;
      let meta: Record<string, unknown> | null = null;
      const execute = createAcpxLocalExecutor({
        createRuntime: (options) => {
          runtime = new FakeRuntime(options);
          return runtime;
        },
      });

      const result = await execute(buildContext(root, {
        config: {
          agent: "claude",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          paperclipRuntimeSkills: [skill],
          paperclipSkillSync: {
            desiredSkills: [skill.key],
          },
        },
        onMeta: async (payload) => {
          meta = payload as Record<string, unknown>;
        },
      }));

      expect(result.exitCode).toBe(0);
      expect(runtime?.options).not.toHaveProperty("sessionOptions");
      const skillRoot = result.sessionParams?.skills && typeof result.sessionParams.skills === "object"
        ? (result.sessionParams.skills as { skillRoot?: string | null }).skillRoot
        : null;
      expect(skillRoot).toContain(path.join("state", "runtime-skills", "claude"));
      await expect(fs.lstat(path.join(skillRoot!, skill.runtimeName))).resolves.toMatchObject({});
      expect(result.sessionParams?.skills).toMatchObject({
        mode: "claude",
        selectedSkills: [skill.runtimeName],
      });
      expect(String(meta?.prompt ?? "")).toContain(`Skill root: ${skillRoot}`);
      expect((meta?.commandNotes as string[]).join("\n")).toContain("Materialized 1 Paperclip skill");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes skill content in the ACPX Claude session fingerprint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-claude-fingerprint-"));
    try {
      const skill = await createRuntimeSkill(root, { body: "---\nrequired: false\n---\nFirst version.\n" });
      const runtimes: FakeRuntime[] = [];
      const execute = createAcpxLocalExecutor({
        createRuntime: (options) => {
          const runtime = new FakeRuntime(options);
          runtimes.push(runtime);
          return runtime;
        },
      });
      const context = buildContext(root, {
        config: {
          agent: "claude",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          paperclipRuntimeSkills: [skill],
          paperclipSkillSync: {
            desiredSkills: [skill.key],
          },
        },
      });

      const first = await execute(context);
      await fs.writeFile(path.join(skill.source, "SKILL.md"), "---\nrequired: false\n---\nSecond version.\n", "utf8");
      const second = await execute({
        ...context,
        runtime: {
          sessionId: first.sessionId ?? null,
          sessionParams: first.sessionParams ?? null,
          sessionDisplayId: first.sessionDisplayId ?? null,
          taskKey: "PAP-1",
        },
      });

      expect(second.sessionParams?.configFingerprint).not.toBe(first.sessionParams?.configFingerprint);
      expect(runtimes.at(-1)?.ensureInputs.at(-1)?.resumeSessionId).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("materializes selected skills into the effective ACPX Codex CODEX_HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-codex-skills-"));
    try {
      const skill = await createRuntimeSkill(root, {});
      const codexHome = path.join(root, "codex-home");
      let runtime: FakeRuntime | null = null;
      let meta: Record<string, unknown> | null = null;
      const execute = createAcpxLocalExecutor({
        createRuntime: (options) => {
          runtime = new FakeRuntime(options);
          return runtime;
        },
      });

      const result = await execute(buildContext(root, {
        config: {
          agent: "codex",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          env: { CODEX_HOME: codexHome },
          paperclipRuntimeSkills: [skill],
          paperclipSkillSync: {
            desiredSkills: [skill.key],
          },
        },
        onMeta: async (payload) => {
          meta = payload as Record<string, unknown>;
        },
      }));

      expect(result.exitCode).toBe(0);
      await expect(fs.lstat(path.join(codexHome, "skills", skill.runtimeName))).resolves.toMatchObject({});
      const wrapperPath = runtime?.options.agentRegistry.resolve("codex");
      const wrapper = await fs.readFile(wrapperPath!, "utf8");
      expect(wrapper).not.toContain("CODEX_HOME");
      expect(wrapper).not.toContain(codexHome);
      expect((meta?.env as Record<string, string>).CODEX_HOME).toBe(codexHome);
      expect(result.sessionParams?.skills).toMatchObject({
        mode: "codex",
        codexHome,
        selectedSkills: [skill.runtimeName],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ACPX custom skill selection tracked without runtime materialization", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-custom-skills-"));
    try {
      const skill = await createRuntimeSkill(root, {});
      let runtime: FakeRuntime | null = null;
      let meta: Record<string, unknown> | null = null;
      const execute = createAcpxLocalExecutor({
        createRuntime: (options) => {
          runtime = new FakeRuntime(options);
          return runtime;
        },
      });

      const result = await execute(buildContext(root, {
        config: {
          agent: "custom",
          agentCommand: "custom-acp",
          cwd: root,
          stateDir: path.join(root, "state"),
          promptTemplate: "Do the assigned work.",
          paperclipRuntimeSkills: [skill],
          paperclipSkillSync: {
            desiredSkills: [skill.key],
          },
        },
        onMeta: async (payload) => {
          meta = payload as Record<string, unknown>;
        },
      }));

      expect(result.exitCode).toBe(0);
      expect(runtime?.options.sessionOptions).toBeUndefined();
      await expect(fs.lstat(path.join(root, "state", "runtime-skills"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.sessionParams?.skills).toMatchObject({
        mode: "custom_unsupported",
        desiredSkillNames: [skill.key],
      });
      expect((meta?.commandNotes as string[]).join("\n")).toContain("tracked only");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

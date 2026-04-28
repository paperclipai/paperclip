import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execute, setCopilotClientFactoryForTests } from "./index.js";
import type { SessionEvent } from "./sdk-client.js";

const __testRoot = fileURLToPath(new URL("../../.test-runtime/", import.meta.url));

async function createTestRoot(prefix: string): Promise<string> {
  await fs.mkdir(__testRoot, { recursive: true });
  return fs.mkdtemp(path.join(__testRoot, `${prefix}-`));
}

function event<T extends SessionEvent["type"]>(
  type: T,
  data: Extract<SessionEvent, { type: T }>["data"],
  options: Partial<SessionEvent> = {},
): Extract<SessionEvent, { type: T }> {
  return {
    id: options.id ?? `${type}-${Math.random().toString(16).slice(2)}`,
    timestamp: options.timestamp ?? new Date(2000).toISOString(),
    parentId: options.parentId ?? null,
    ...(typeof options.ephemeral === "boolean" ? { ephemeral: options.ephemeral } : {}),
    type,
    data,
  } as Extract<SessionEvent, { type: T }>;
}

class FakeSession {
  public readonly sessionId: string;
  public readonly rpc = {};
  public lastPrompt = "";
  private readonly history: SessionEvent[];
  private readonly turnEvents: SessionEvent[];
  private readonly disconnectEvents: SessionEvent[];
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(input: {
    sessionId: string;
    history?: SessionEvent[];
    turnEvents?: SessionEvent[];
    disconnectEvents?: SessionEvent[];
  }) {
    this.sessionId = input.sessionId;
    this.history = [...(input.history ?? [])];
    this.turnEvents = [...(input.turnEvents ?? [])];
    this.disconnectEvents = [...(input.disconnectEvents ?? [])];
  }

  on(handler: (event: SessionEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async send(input: { prompt: string }): Promise<string> {
    this.lastPrompt = input.prompt;
    for (const current of this.turnEvents) {
      this.emit(current);
    }
    return "message-1";
  }

  async getMessages(): Promise<SessionEvent[]> {
    return [...this.history];
  }

  async disconnect(): Promise<void> {
    for (const current of this.disconnectEvents) {
      this.emit(current);
    }
  }

  async abort(): Promise<void> {
    // no-op for test sessions
  }

  private emit(current: SessionEvent): void {
    this.history.push(current);
    for (const handler of this.listeners) {
      handler(current);
    }
  }
}

afterEach(async () => {
  setCopilotClientFactoryForTests(null);
  await fs.rm(__testRoot, { recursive: true, force: true });
});

describe("copilot execute", () => {
  it("runs through the SDK client, injects instructions/skills, and returns parsed usage", async () => {
    const root = await createTestRoot("execute-success");
    const workspace = path.join(root, "workspace");
    const instructionsFile = path.join(root, "instructions.md");
    const skillsRoot = path.join(root, "runtime-skills");
    const capture = {
      options: null as Record<string, unknown> | null,
      sessionConfig: null as Record<string, unknown> | null,
      spawnCalls: [] as Array<{ pid: number; processGroupId: number | null; startedAt: string }>,
      meta: [] as Array<Record<string, unknown>>,
      logs: [] as string[],
    };

    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsFile, "# Follow the runbook", "utf8");
    await fs.mkdir(path.join(skillsRoot, "paperclip"), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, "paperclip", "SKILL.md"), "# paperclip", "utf8");

    const session = new FakeSession({
      sessionId: "sdk-session-1",
      turnEvents: [
        event("assistant.message", {
          messageId: "m-1",
          content: "Completed the task.",
          outputTokens: 4,
        }),
        event(
          "assistant.usage",
          {
            model: "gpt-5.4",
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 2,
            cacheWriteTokens: 0,
            cost: 1.5,
            duration: 321,
          },
          { ephemeral: true },
        ),
        event("tool.execution_start", {
          toolCallId: "tool-1",
          toolName: "edit_file",
          arguments: { path: "src/changed.ts" },
        }),
        event("session.idle", { aborted: false }, { ephemeral: true }),
      ],
      disconnectEvents: [
        event("session.shutdown", {
          shutdownType: "routine",
          totalPremiumRequests: 1.5,
          totalApiDurationMs: 321,
          sessionStartTime: 1000,
          codeChanges: {
            linesAdded: 3,
            linesRemoved: 1,
            filesModified: ["src/changed.ts"],
          },
          modelMetrics: {
            "gpt-5.4": {
              requests: { count: 1, cost: 1.5 },
              usage: {
                inputTokens: 10,
                outputTokens: 4,
                cacheReadTokens: 2,
                cacheWriteTokens: 0,
              },
            },
          },
          currentModel: "gpt-5.4",
        }),
      ],
    });

    setCopilotClientFactoryForTests((options) => {
      capture.options = options as unknown as Record<string, unknown>;
      const stderr = new EventEmitter();
      return {
        cliProcess: { pid: 4242, stderr } as unknown,
        start: async () => {},
        stop: async () => [],
        forceStop: async () => {},
        ping: async () => ({ message: "ok", timestamp: Date.now() }),
        getStatus: async () => ({ version: "1.0.0", protocolVersion: 1 }),
        getAuthStatus: async () => ({
          isAuthenticated: true,
          authType: "env",
          login: "paperclip-bot",
        }),
        listModels: async () => [{ id: "gpt-5.4", name: "GPT 5.4" }],
        createSession: async (sessionConfig: unknown) => {
          capture.sessionConfig = sessionConfig as unknown as Record<string, unknown>;
          return session as never;
        },
        resumeSession: async () => {
          throw new Error("resume should not be used");
        },
      } as never;
    });

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Copilot Agent",
        adapterType: "copilot_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: workspace,
        instructionsFilePath: instructionsFile,
        promptTemplate: "Continue the Paperclip work.",
        paperclipRuntimeSkills: [
          {
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: path.join(skillsRoot, "paperclip"),
          },
        ],
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
      context: {},
      authToken: "run-jwt-token",
      onLog: async (_stream, chunk) => {
        capture.logs.push(chunk);
      },
      onMeta: async (meta) => {
        capture.meta.push(meta as unknown as Record<string, unknown>);
      },
      onSpawn: async (spawn) => {
        capture.spawnCalls.push(spawn);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
    });
    expect(result.summary).toBe("Completed the task.");
    expect(result.sessionId).toBe("sdk-session-1");
    expect(result.model).toBe("gpt-5.4");
    expect(result.resultJson).toMatchObject({
      premiumRequests: 1.5,
      totalApiDurationMs: 321,
      codeChanges: {
        linesAdded: 3,
        linesRemoved: 1,
        filesModified: ["src/changed.ts"],
      },
    });
    expect(capture.options).toMatchObject({
      env: expect.objectContaining({
        PAPERCLIP_API_KEY: "run-jwt-token",
        PAPERCLIP_RUN_ID: "run-1",
      }),
    });
    expect(capture.sessionConfig).toMatchObject({
      model: "gpt-5.4",
      workingDirectory: workspace,
      systemMessage: expect.objectContaining({
        mode: "append",
      }),
    });
    expect(
      String((capture.sessionConfig?.systemMessage as { content?: string } | undefined)?.content),
    ).toContain("# Follow the runbook");
    expect(capture.spawnCalls).toHaveLength(1);
    expect(capture.meta[0]?.commandNotes).toEqual(
      expect.arrayContaining([
        "Using the GitHub Copilot SDK JSON-RPC runtime.",
      ]),
    );
    expect(session.lastPrompt).toContain("Continue the Paperclip work.");
  });

  it("retries with a fresh SDK session when resumeSession reports an unknown session", async () => {
    const root = await createTestRoot("execute-retry");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const freshSession = new FakeSession({
      sessionId: "sdk-session-fresh",
      turnEvents: [
        event("assistant.message", {
          messageId: "m-2",
          content: "Fresh session reply.",
        }),
        event("session.idle", { aborted: false }, { ephemeral: true }),
      ],
    });

    const factories = [
      {
        start: async () => {},
        stop: async () => [],
        forceStop: async () => {},
        ping: async () => ({ message: "ok", timestamp: Date.now() }),
        getStatus: async () => ({ version: "1.0.0", protocolVersion: 1 }),
        getAuthStatus: async () => ({ isAuthenticated: true }),
        listModels: async () => [{ id: "gpt-5.4", name: "GPT 5.4" }],
        createSession: async () => {
          throw new Error("createSession should not run on the first attempt");
        },
        resumeSession: async () => {
          throw new Error("Unknown session: stale-session");
        },
      },
      {
        start: async () => {},
        stop: async () => [],
        forceStop: async () => {},
        ping: async () => ({ message: "ok", timestamp: Date.now() }),
        getStatus: async () => ({ version: "1.0.0", protocolVersion: 1 }),
        getAuthStatus: async () => ({ isAuthenticated: true }),
        listModels: async () => [{ id: "gpt-5.4", name: "GPT 5.4" }],
        createSession: async () => freshSession as never,
        resumeSession: async () => {
          throw new Error("resumeSession should not run on the retry");
        },
      },
    ];
    const logs: string[] = [];

    setCopilotClientFactoryForTests(() => factories.shift() as never);

    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-2",
        companyId: "company-1",
        name: "Copilot Agent",
        adapterType: "copilot_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "stale-session",
        sessionParams: { sessionId: "stale-session", cwd: workspace },
        sessionDisplayId: "stale-session",
        taskKey: null,
      },
      config: {
        cwd: workspace,
        promptTemplate: "Retry the work.",
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sdk-session-fresh");
    expect(result.summary).toBe("Fresh session reply.");
    expect(result.clearSession).toBe(false);
    expect(logs.join("")).toContain("retrying with a fresh SDK session");
  });
});

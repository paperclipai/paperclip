import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

type MockRunOptions = {
  id?: string;
  agentId?: string;
  status?: string;
  waitResult?: Record<string, unknown>;
  streamMessages?: unknown[];
  streamError?: Error | null;
};

type MockAgentOptions = {
  agentId?: string;
  sendRun?: ReturnType<typeof createMockRun>;
};

const { createMock, resumeMock, getRunMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  resumeMock: vi.fn(),
  getRunMock: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: createMock,
    resume: resumeMock,
    getRun: getRunMock,
  },
}));

function createMockRun(options: MockRunOptions = {}) {
  const runId = options.id ?? "run-123";
  const agentId = options.agentId ?? "agent-123";
  const status = options.status ?? "finished";
  const waitResult = options.waitResult ?? {
    id: runId,
    status,
    result: "Done\nWith detail",
    model: { id: "gpt-5.4" },
    durationMs: 1234,
  };
  const streamMessages = options.streamMessages ?? [];
  const streamError = options.streamError ?? null;

  return {
    id: runId,
    agentId,
    status,
    result: typeof waitResult.result === "string" ? waitResult.result : null,
    model: waitResult.model ?? null,
    durationMs: waitResult.durationMs ?? null,
    git: waitResult.git ?? null,
    supports(capability: string) {
      return capability === "stream" || capability === "wait";
    },
    async *stream() {
      for (const message of streamMessages) yield message;
      if (streamError) throw streamError;
    },
    async wait() {
      return waitResult;
    },
  };
}

function createMockSdkAgent(options: MockAgentOptions = {}) {
  const sendRun = options.sendRun ?? createMockRun();
  return {
    agentId: options.agentId ?? sendRun.agentId,
    send: vi.fn(async () => sendRun),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}

function createContext(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext & {
  logs: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
  meta: Record<string, unknown>[];
} {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const meta: Record<string, unknown>[] = [];
  const agent = overrides.agent ?? {
    id: "agent-1",
    companyId: "company-1",
    name: "Cursor Cloud Agent",
    adapterType: "cursor_cloud",
    adapterConfig: {},
  };
  const runtime = overrides.runtime ?? {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
  };
  const config = overrides.config ?? {
    env: {
      CURSOR_API_KEY: "cursor-secret",
      EXTRA_FLAG: "1",
    },
    repoUrl: "https://github.com/paperclipai/paperclip.git",
    repoStartingRef: "main",
    runtimeEnvType: "cloud",
    promptTemplate: "Do the work for {{agent.name}}",
    model: "gpt-5.4",
  };
  const context = overrides.context ?? {
    taskId: "issue-1",
    issueId: "issue-1",
    wakeReason: "issue_commented",
  };

  const base: AdapterExecutionContext = {
    runId: "run-heartbeat-1",
    agent,
    runtime,
    config,
    context,
    authToken: "paperclip-run-jwt",
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    onMeta: async (entry) => {
      meta.push(entry as unknown as Record<string, unknown>);
    },
  };

  return {
    ...base,
    ...overrides,
    logs,
    meta,
  };
}

describe("cursor_cloud execute", () => {
  beforeEach(() => {
    createMock.mockReset();
    resumeMock.mockReset();
    getRunMock.mockReset();
  });

  it("creates a fresh Cursor agent and injects Paperclip env without CURSOR_API_KEY", async () => {
    const run = createMockRun({
      agentId: "agent-fresh",
      streamMessages: [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Working" }],
          },
        },
      ],
    });
    const sdkAgent = createMockSdkAgent({ agentId: "agent-fresh", sendRun: run });
    createMock.mockResolvedValue(sdkAgent);
    const ctx = createContext();

    const result = await execute(ctx);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(resumeMock).not.toHaveBeenCalled();
    expect(getRunMock).not.toHaveBeenCalled();
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      apiKey: "cursor-secret",
      name: "Paperclip Cursor Cloud Agent",
      model: { id: "gpt-5.4" },
      cloud: {
        env: { type: "cloud" },
        repos: [{ url: "https://github.com/paperclipai/paperclip.git", startingRef: "main" }],
      },
    });
    expect(createMock.mock.calls[0]?.[0]?.cloud?.envVars).toMatchObject({
      EXTRA_FLAG: "1",
      PAPERCLIP_RUN_ID: "run-heartbeat-1",
      PAPERCLIP_TASK_ID: "issue-1",
      PAPERCLIP_WAKE_REASON: "issue_commented",
      PAPERCLIP_API_KEY: "paperclip-run-jwt",
    });
    expect(createMock.mock.calls[0]?.[0]?.cloud?.envVars).not.toHaveProperty("CURSOR_API_KEY");

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      sessionId: "agent-fresh",
      model: "gpt-5.4",
      summary: "Done",
      sessionParams: {
        cursorAgentId: "agent-fresh",
        latestRunId: "run-123",
        runtime: "cloud",
        envType: "cloud",
        repos: [{ url: "https://github.com/paperclipai/paperclip.git", startingRef: "main" }],
      },
    });
    expect(ctx.logs.map((entry) => entry.chunk)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"type":"cursor_cloud.init"'),
        expect.stringContaining('"type":"cursor_cloud.message"'),
        expect.stringContaining('"type":"cursor_cloud.result"'),
      ]),
    );
  });

  it("resumes a matching saved session when no active run can be reattached", async () => {
    getRunMock.mockResolvedValue(createMockRun({ status: "finished" }));
    const resumedRun = createMockRun({ id: "run-resumed", agentId: "agent-resumed" });
    const sdkAgent = createMockSdkAgent({ agentId: "agent-resumed", sendRun: resumedRun });
    resumeMock.mockResolvedValue(sdkAgent);
    const ctx = createContext({
      runtime: {
        sessionId: null,
        sessionDisplayId: "agent-previous",
        taskKey: null,
        sessionParams: {
          cursorAgentId: "agent-previous",
          latestRunId: "run-previous",
          runtime: "cloud",
          envType: "cloud",
          repos: [{ url: "https://github.com/paperclipai/paperclip.git", startingRef: "main" }],
        },
      },
    });

    const result = await execute(ctx);

    expect(getRunMock).toHaveBeenCalledWith("run-previous", {
      runtime: "cloud",
      agentId: "agent-previous",
      apiKey: "cursor-secret",
    });
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(sdkAgent.send).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("agent-resumed");
  });

  it("reattaches to an active run, drains it, then sends the heartbeat as a follow-up", async () => {
    const attachedRun = createMockRun({
      id: "run-attached",
      agentId: "agent-attached",
      status: "running",
      waitResult: {
        id: "run-attached",
        status: "finished",
        result: "Prior result",
        model: { id: "gpt-5.4" },
      },
      streamMessages: [
        {
          type: "status",
          status: "running",
          message: "Still working",
        },
      ],
    });
    getRunMock.mockResolvedValue(attachedRun);
    const followUpRun = createMockRun({
      id: "run-followup",
      agentId: "agent-attached",
      waitResult: {
        id: "run-followup",
        status: "finished",
        result: "Follow-up result",
        model: { id: "gpt-5.4" },
      },
    });
    const sdkAgent = createMockSdkAgent({ agentId: "agent-attached", sendRun: followUpRun });
    resumeMock.mockResolvedValue(sdkAgent);
    const ctx = createContext({
      runtime: {
        sessionId: null,
        sessionDisplayId: "agent-attached",
        taskKey: null,
        sessionParams: {
          cursorAgentId: "agent-attached",
          latestRunId: "run-attached",
          runtime: "cloud",
          envType: "cloud",
          repos: [{ url: "https://github.com/paperclipai/paperclip.git", startingRef: "main" }],
        },
      },
    });

    const result = await execute(ctx);

    expect(getRunMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(sdkAgent.send).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      exitCode: 0,
      sessionId: "agent-attached",
      summary: "Follow-up result",
      resultJson: {
        cursorRunId: "run-followup",
      },
    });
    const logChunks = ctx.logs.map((entry) => entry.chunk);
    expect(logChunks).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Reattached to existing Cursor run run-attached."),
        expect.stringContaining("Prior Cursor run run-attached finished"),
        expect.stringContaining("Started Cursor run run-followup."),
        expect.stringContaining('"runId":"run-attached"'),
        expect.stringContaining('"runId":"run-followup"'),
      ]),
    );
    expect(ctx.meta[0]?.context).toMatchObject({
      cursorCloud: {
        canReuseSession: true,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
      },
    });
  });

  it("maps non-finished Cursor results to failing Paperclip runs", async () => {
    const cancelledRun = createMockRun({
      id: "run-cancelled",
      agentId: "agent-cancelled",
      status: "cancelled",
      waitResult: {
        id: "run-cancelled",
        status: "cancelled",
        result: "",
        model: { id: "gpt-5.4" },
      },
    });
    const sdkAgent = createMockSdkAgent({ agentId: "agent-cancelled", sendRun: cancelledRun });
    createMock.mockResolvedValue(sdkAgent);
    const ctx = createContext();

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 1,
      errorMessage: "Cursor run cancelled",
      sessionId: "agent-cancelled",
      resultJson: {
        status: "cancelled",
        cursorAgentId: "agent-cancelled",
        cursorRunId: "run-cancelled",
      },
    });
  });
});

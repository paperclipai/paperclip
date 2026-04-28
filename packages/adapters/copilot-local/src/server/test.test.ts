import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setCopilotClientFactoryForTests,
  testEnvironment,
} from "./index.js";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import type { SessionEvent } from "./sdk-client.js";

const __testRoot = fileURLToPath(new URL("../../.test-runtime/", import.meta.url));

async function createTestRoot(prefix: string): Promise<string> {
  await fs.mkdir(__testRoot, { recursive: true });
  return fs.mkdtemp(path.join(__testRoot, `${prefix}-`));
}

function event<T extends SessionEvent["type"]>(
  type: T,
  data: Extract<SessionEvent, { type: T }>["data"],
): Extract<SessionEvent, { type: T }> {
  return {
    id: `${type}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date(2000).toISOString(),
    parentId: null,
    type,
    data,
  } as Extract<SessionEvent, { type: T }>;
}

class FakeSession {
  public readonly sessionId = "probe-session";
  public readonly rpc = {};
  public sentPrompts: string[] = [];
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly sendEvents: SessionEvent[];

  constructor(sendEvents: SessionEvent[]) {
    this.sendEvents = sendEvents;
  }

  on(handler: (event: SessionEvent) => void): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  async send(input: { prompt: string }): Promise<string> {
    this.sentPrompts.push(input.prompt);
    for (const current of this.sendEvents) {
      for (const handler of this.listeners) {
        handler(current);
      }
    }
    return "message-1";
  }

  async getMessages(): Promise<SessionEvent[]> {
    return [...this.sendEvents];
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async abort(): Promise<void> {
    // no-op
  }
}

afterEach(async () => {
  setCopilotClientFactoryForTests(null);
  vi.restoreAllMocks();
  await fs.rm(__testRoot, { recursive: true, force: true });
});

describe("copilot environment test", () => {
  it("warns for unavailable configured models and probes with the default model", async () => {
    const root = await createTestRoot("env-probe");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const session = new FakeSession([
      event("assistant.message", {
        messageId: "assistant-1",
        content: "hello",
      }),
      event("session.idle", { aborted: false }),
    ]);
    const createSession = vi.fn(async () => session as never);

    setCopilotClientFactoryForTests(() => ({
      start: async () => {},
      stop: async () => [],
      forceStop: async () => {},
      ping: async () => ({ message: "ok", timestamp: Date.now() }),
      getStatus: async () => ({ version: "1.0.0", protocolVersion: 1 }),
      getAuthStatus: async () => ({
        isAuthenticated: true,
        login: "paperclip-bot",
        authType: "oauth",
      }),
      listModels: async () => [{ id: DEFAULT_COPILOT_LOCAL_MODEL, name: "GPT 5.4" }],
      createSession,
      resumeSession: async () => {
        throw new Error("resumeSession should not be used");
      },
    }) as never);

    const result = await testEnvironment({
      adapterType: "copilot_local",
      companyId: "company-1",
      config: {
        cwd: workspace,
        model: "missing-model",
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        "copilot_sdk_started",
        "copilot_sdk_auth_ready",
        "copilot_models_listed",
        "copilot_model_unavailable",
        "copilot_sdk_send_probe_passed",
      ]),
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_COPILOT_LOCAL_MODEL,
        workingDirectory: workspace,
      }),
    );
    expect(session.sentPrompts).toEqual(["Reply with the single word: hello"]);
  });

  it("reports authentication as not ready and skips the send probe", async () => {
    const root = await createTestRoot("env-auth");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const createSession = vi.fn();

    setCopilotClientFactoryForTests(() => ({
      start: async () => {},
      stop: async () => [],
      forceStop: async () => {},
      ping: async () => ({ message: "ok", timestamp: Date.now() }),
      getStatus: async () => ({ version: "1.0.0", protocolVersion: 1 }),
      getAuthStatus: async () => ({
        isAuthenticated: false,
        statusMessage: "Run `copilot auth login` first.",
      }),
      listModels: async () => [{ id: DEFAULT_COPILOT_LOCAL_MODEL, name: "GPT 5.4" }],
      createSession,
      resumeSession: async () => {
        throw new Error("resumeSession should not be used");
      },
    }) as never);

    const result = await testEnvironment({
      adapterType: "copilot_local",
      companyId: "company-1",
      config: {
        cwd: workspace,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        "copilot_sdk_started",
        "copilot_sdk_auth_required",
        "copilot_models_listed",
        "copilot_model_available",
      ]),
    );
    expect(result.checks.map((check) => check.code)).not.toContain("copilot_sdk_send_probe_passed");
    expect(createSession).not.toHaveBeenCalled();
  });
});

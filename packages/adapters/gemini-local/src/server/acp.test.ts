import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import {
  buildGeminiAcpConfig,
  createGeminiAcpExecutor,
  nodeVersionMeetsGeminiAcpMinimum,
  resolveGeminiExecutionEngine,
  resolveGeminiExecutionEngineForRun,
  testGeminiAcpEnvironment,
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
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;

function setNodeVersion(version: string): void {
  Object.defineProperty(process, "version", {
    configurable: true,
    enumerable: true,
    value: version,
  });
}

afterEach(async () => {
  setNodeVersion(originalNodeVersion);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;
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

function buildContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Gemini ACP",
      adapterType: "gemini_local",
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
      command: "fake-gemini",
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

describe("gemini_local ACP lane", () => {
  it("maps Gemini config to the ACPX Gemini target", () => {
    expect(buildGeminiAcpConfig({
      engine: "acp",
      cwd: "/repo",
      model: "gemini-2.5-pro",
      command: "/opt/gemini",
      warmHandleIdleMs: 25,
    })).toMatchObject({
      agent: "gemini",
      cwd: "/repo",
      model: "gemini-2.5-pro",
      agentCommand: "/opt/gemini --acp",
      mode: "persistent",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      warmHandleIdleMs: 25,
    });

    expect(buildGeminiAcpConfig({ engine: "acp", model: "auto" })).not.toHaveProperty("model");
    expect(buildGeminiAcpConfig({ engine: "acp", agentCommand: "custom-gemini-acp" })).toMatchObject({
      agentCommand: "custom-gemini-acp",
    });
  });

  it("checks the Node version required by the Gemini ACP runtime", () => {
    setNodeVersion("v19.9.0");
    expect(nodeVersionMeetsGeminiAcpMinimum()).toBe(false);
    setNodeVersion("v20.0.0");
    expect(nodeVersionMeetsGeminiAcpMinimum()).toBe(true);
  });

  it("defaults to ACP when prerequisites pass and falls back to CLI only for auto resolution", async () => {
    const root = await makeTempRoot("paperclip-gemini-acp-default-");
    const commandPath = path.join(root, "bin", "gemini");
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, "#!/usr/bin/env sh\n", "utf8");
    setNodeVersion("v20.0.0");

    expect(resolveGeminiExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveGeminiExecutionEngineForRun({
        config: { command: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: false });
    await expect(
      resolveGeminiExecutionEngineForRun({
        config: { engine: "cli", command: commandPath },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "cli", explicit: true });
    expect(resolveGeminiExecutionEngine({ engine: "acp" })).toEqual({
      engine: "acp",
      explicit: true,
    });

    setNodeVersion("v19.9.0");
    await expect(
      resolveGeminiExecutionEngineForRun({
        config: { command: commandPath },
        executionTarget: null,
      }),
    ).resolves.toMatchObject({
      engine: "cli",
      explicit: false,
      fallbackReason: expect.stringContaining("Node"),
    });
    await expect(
      resolveGeminiExecutionEngineForRun({
        config: { engine: "acp", command: "/missing/gemini" },
        executionTarget: null,
      }),
    ).resolves.toEqual({ engine: "acp", explicit: true });
  });

  it("falls back to the CLI lane for remote auto runs", async () => {
    await expect(
      resolveGeminiExecutionEngineForRun({
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
      fallbackReason: expect.stringContaining("remote environment"),
    });
  });

  it("executes Gemini through the shared ACP runtime", async () => {
    const root = await makeTempRoot("paperclip-gemini-acp-run-");
    process.env.HOME = path.join(root, "home");
    const runtime = new FakeRuntime({});
    const metas: AdapterInvocationMeta[] = [];
    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createGeminiAcpExecutor({
      createRuntime: (options) => {
        Object.assign(runtime.options, options);
        return runtime as never;
      },
    });

    const result = await execute(buildContext(root, {
      onMeta: async (meta) => {
        metas.push(meta);
      },
      onLog: async (stream, text) => {
        logs.push({ stream, text });
      },
    }));

    expect(runtime.ensureInputs[0]).toMatchObject({
      agent: "gemini",
      mode: "persistent",
      cwd: root,
    });
    expect(runtime.startInputs[0]?.text).toContain("Do the assigned work.");
    expect(result).toMatchObject({
      exitCode: 0,
      provider: "acpx",
      sessionId: "acp-1",
      sessionDisplayId: "agent-1",
      summary: "hello",
    });
    expect(result.sessionParams).toMatchObject({
      agent: "gemini",
      acpSessionId: "acp-1",
      cwd: root,
    });
    expect(metas[0]).toMatchObject({
      adapterType: "gemini_local",
      command: "fake-gemini --acp",
    });
    expect(logs.some((entry) => entry.text.includes("\"type\":\"acpx.session\""))).toBe(true);
  });

  it("reports Gemini ACP environment readiness", async () => {
    const root = await makeTempRoot("paperclip-gemini-acp-env-");
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "gemini"), "#!/usr/bin/env sh\n", "utf8");
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.GEMINI_API_KEY = "test-key";
    setNodeVersion("v20.0.0");

    const result = await testGeminiAcpEnvironment({
      adapterType: "gemini_local",
      companyId: "company-1",
      config: {
        engine: "acp",
        cwd: root,
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "gemini_engine_selected" }),
        expect.objectContaining({ code: "gemini_acp_command_resolvable" }),
        expect.objectContaining({ code: "gemini_acp_credentials_detected" }),
      ]),
    );
  });
});

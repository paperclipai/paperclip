import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import {
  buildGeminiAcpConfig,
  createGeminiAcpExecutor,
  nodeVersionMeetsGeminiAcpMinimum,
  resolveGeminiExecutionEngine,
  resolveGeminiExecutionEngineForRun,
  testGeminiAcpEnvironment,
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
      return await runChildProcess(`gemini-acp-sandbox-run-${counter}`, command, input.args ?? [], {
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

  it("falls back to the CLI lane for non-sandbox remote auto runs", async () => {
    setNodeVersion("v20.0.0");
    await expect(
      resolveGeminiExecutionEngineForRun({
        config: { agentCommand: "gemini --acp" },
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

  it("falls back to the CLI lane for one-shot sandbox auto runs", async () => {
    setNodeVersion("v20.0.0");
    await expect(
      resolveGeminiExecutionEngineForRun({
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

  it("uses ACP for bridged sandbox auto runs when the ACP command is configured as a shell command", async () => {
    setNodeVersion("v20.0.0");
    await expect(
      resolveGeminiExecutionEngineForRun({
        config: { agentCommand: "gemini --acp" },
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
    ).resolves.toEqual({
      engine: "acp",
      explicit: false,
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

  it("creates the ACP session on the in-sandbox workspace cwd for runner-backed remote runs", async () => {
    const root = await makeTempRoot("paperclip-gemini-acp-remote-cwd-");
    process.env.HOME = path.join(root, "home");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");

    const runtime = new FakeRuntime({});
    const execute = createGeminiAcpExecutor({
      createRuntime: (options) => {
        Object.assign(runtime.options, options);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          // Throwaway ACP command so the process-session bridge does not require
          // a real gemini binary in the local sandbox stand-in.
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
    expect(runtime.ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(runtime.ensureInputs[0]?.cwd).not.toBe(localCwd);
  });

  it("seeds the managed Gemini home into the sandbox, repoints HOME, and keeps the key file-only", async () => {
    const root = await makeTempRoot("paperclip-gemini-acp-home-seed-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const hostHome = path.join(root, "home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    // A selected skill so the shipped skills asset has content to seed.
    const skillSource = path.join(root, "skills", "review");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\n---\nUse the review skill.\n", "utf8");
    // The credential is delivered through the adapter-config env — the run env the
    // seam forwards into the sandbox — so pre-selecting api-key auth is backed by a
    // credential that is actually available in-sandbox. A stray host-only key must
    // NOT be relied on, so we clear it to prove the selection comes from the run env.
    const SECRET_KEY = "AIza-secret-key-value-SENTINEL";
    process.env.HOME = hostHome;
    delete process.env.GEMINI_API_KEY;

    const meta: AdapterInvocationMeta[] = [];
    const runtime = new FakeRuntime({});
    const execute = createGeminiAcpExecutor({
      createRuntime: (options) => {
        Object.assign(runtime.options, options);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          // Drive resolveGeminiSkillsHome to a temp home so the engine prepares
          // skills off the real ~/.gemini, and deliver the key via config env.
          env: { HOME: hostHome, GEMINI_API_KEY: SECRET_KEY },
          promptTemplate: "Do the assigned work.",
          paperclipRuntimeSkills: [{ key: "company/review", runtimeName: "review", source: skillSource }],
          paperclipSkillSync: { desiredSkills: ["company/review"] },
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
        onMeta: async (payload) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const remappedHome = String(meta[0]?.env?.HOME ?? "");
    // C2 — HOME repointed onto the in-sandbox managed runtime root, distinct from
    // the host home.
    expect(remappedHome).not.toBe(hostHome);
    expect(remappedHome).toContain(".paperclip-runtime");
    // Seeded: skills copied into $HOME/.gemini/skills (local runner = host FS).
    await expect(
      fs.readFile(path.join(remappedHome, ".gemini", "skills", "review", "SKILL.md"), "utf8"),
    ).resolves.toContain("review skill");
    // settings.json pre-selects api-key auth but carries no key bytes.
    const settingsRaw = await fs.readFile(path.join(remappedHome, ".gemini", "settings.json"), "utf8");
    expect(settingsRaw).toContain("gemini-api-key");
    expect(settingsRaw).not.toContain(SECRET_KEY);
    // The selector is backed by a credential the sandbox actually receives: the key
    // rides in the forwarded run env (that is how it reaches the sandbox). The
    // invocation meta redacts the value for logging, so it is present but never the
    // raw bytes; the settings.json selector above proves the seam saw it in-env.
    expect(meta[0]?.env?.GEMINI_API_KEY).toBeDefined();
    expect(meta[0]?.env?.GEMINI_API_KEY).not.toBe(SECRET_KEY);
    // C4 — no XDG_* variable introduced for credential discovery.
    expect(Object.keys(meta[0]?.env ?? {}).filter((key) => key.startsWith("XDG_"))).toEqual([]);
  });

  it("does not persist an api-key auth selector from a host-only credential", async () => {
    const root = await makeTempRoot("paperclip-gemini-acp-hostkey-");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    const hostHome = path.join(root, "home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    // The key exists ONLY in the host process env — never in the adapter-config env
    // — so the remote sandbox (which does not inherit the host environment) will not
    // receive it. Selecting api-key auth off this host-only signal would start
    // headless Gemini with a credential it cannot see and fail authentication, so
    // the seam must NOT persist a selector here.
    const SECRET_KEY = "AIza-host-only-key-SENTINEL";
    process.env.HOME = hostHome;
    process.env.GEMINI_API_KEY = SECRET_KEY;

    const meta: AdapterInvocationMeta[] = [];
    const runtime = new FakeRuntime({});
    const execute = createGeminiAcpExecutor({
      createRuntime: (options) => {
        Object.assign(runtime.options, options);
        return runtime as never;
      },
    });

    const result = await execute(
      buildContext(localCwd, {
        config: {
          engine: "acp",
          cwd: localCwd,
          agentCommand: "node ./fake-acp.js",
          stateDir: path.join(root, "state"),
          env: { HOME: hostHome },
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
        onMeta: async (payload) => {
          meta.push(payload);
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    const remappedHome = String(meta[0]?.env?.HOME ?? "");
    expect(remappedHome).toContain(".paperclip-runtime");
    // No settings.json auth selector is written, because a host-only key is not a
    // reliable in-sandbox credential signal.
    await expect(
      fs.readFile(path.join(remappedHome, ".gemini", "settings.json"), "utf8"),
    ).rejects.toThrow();
    // And the host-only key never leaks into the forwarded run env.
    for (const value of Object.values(meta[0]?.env ?? {})) {
      expect(String(value)).not.toContain(SECRET_KEY);
    }
  });

  it("falls back to the CLI lane for a runner-less sandbox even when the ACP command is set", async () => {
    setNodeVersion("v22.13.0");
    await expect(
      resolveGeminiExecutionEngineForRun({
        config: { agentCommand: "gemini --acp" },
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

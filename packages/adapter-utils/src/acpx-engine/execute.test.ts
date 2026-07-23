import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import type { AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
import {
  DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  startAdapterExecutionTargetProcessSessionBridge,
} from "@paperclipai/adapter-utils/execution-target";

// Wrap the staging seam + both sandbox bridges in call-recording spies that
// still delegate to the real implementations (a runner-backed sandbox test
// exercises them end-to-end against a local runner). This lets the staging
// tests assert the exact `runtimeRootDir`/`workspaceLocalDir`/`assets` the
// engine threads without changing any real behavior for the other tests.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importActual) => {
  const actual = await importActual<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime: vi.fn(actual.prepareAdapterExecutionTargetRuntime),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(actual.startAdapterExecutionTargetPaperclipBridge),
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(actual.startAdapterExecutionTargetProcessSessionBridge),
  };
});
import {
  createAcpxEngineExecutor,
  findAncestorBin,
  geminiVersionSupportsNativeAcpFlag,
  parseGeminiVersionParts,
  rewriteGeminiAcpFlagForVersion,
  summarizeAcpxTurnUsage,
} from "./execute.js";
import { runChildProcess } from "../server-utils.js";


const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function onlyChildDir(parent: string): Promise<string> {
  const entries = await fs.readdir(parent);
  expect(entries).toHaveLength(1);
  return path.join(parent, entries[0]!);
}

async function createSkill(root: string, name: string, body = `---\nrequired: false\n---\n# ${name}\n`) {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
  return {
    key: `paperclipai/test/${name}`,
    runtimeName: name,
    source: skillDir,
    required: false,
  };
}

function createLocalSandboxRunner(
  onExecute?: (input: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }) => void,
) {
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
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      onExecute?.(input);
      const command = input.command === "bash" ? "/bin/bash" : input.command;
      return await runChildProcess(`acpx-sandbox-run-${counter}`, command, input.args ?? [], {
        cwd: input.cwd ?? process.cwd(),
        env: input.env ?? {},
        stdin: input.stdin,
        timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
        graceSec: 5,
        onLog: input.onLog ?? (async () => {}),
        onSpawn: input.onSpawn
          ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
          : undefined,
      });
    },
  };
}

function buildRuntime(
  onSetConfigOption?: (input: { key: string; value: string }) => void,
  onEnsureSession?: (input: Record<string, unknown>) => void,
) {
  return {
    ensureSession: async (input: Record<string, unknown>) => {
      onEnsureSession?.(input);
      return ({
      backendSessionId: "backend-session",
      agentSessionId: "agent-session",
      runtimeSessionName: "runtime-session",
      });
    },
    startTurn: () => ({
      events: (async function* () {
        yield { type: "done", stopReason: "end_turn" };
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    }),
    setConfigOption: async (input: { key: string; value: string }) => {
      onSetConfigOption?.(input);
    },
    close: async () => {},
  };
}

async function runExecutor(
  config: Record<string, unknown>,
  options: {
    context?: Record<string, unknown>;
    executionTransport?: Record<string, unknown>;
    authToken?: string;
    executionTarget?: Record<string, unknown>;
    runtimeMcp?: AdapterRuntimeMcpAccess;
  } = {},
) {
  const runtimeOptions: Record<string, unknown>[] = [];
  const configOptions: Array<{ key: string; value: string }> = [];
  const sessionInputs: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const execute = createAcpxEngineExecutor({
    createRuntime: (options) => {
      runtimeOptions.push(options as unknown as Record<string, unknown>);
      return buildRuntime(
        ({ key, value }) => configOptions.push({ key, value }),
        (input) => sessionInputs.push(input),
      ) as never;
    },
  });

  const result = await execute({
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
    },
      runtime: {},
      config,
      context: options.context ?? {},
      executionTransport: options.executionTransport,
      authToken: options.authToken,
      executionTarget: options.executionTarget,
      runtimeMcp: options.runtimeMcp,
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
    onMeta: async (payload: unknown) => {
      meta.push(payload as Record<string, unknown>);
    },
  } as never);

  expect(result.exitCode).toBe(0);
  return { logs, meta, runtimeOptions, configOptions, sessionInputs, result };
}

describe("shared ACPX engine runtime behavior", () => {
  it("sets Codex model, effort, and fast mode through CODEX_CONFIG without session config calls", async () => {
    const { configOptions, meta } = await runExecutor({
      agent: "codex",
      model: "gpt-5.6-sol",
      modelReasoningEffort: "high",
      fastMode: true,
    });

    expect(JSON.parse(String((meta[0]?.env as Record<string, string>).CODEX_CONFIG))).toEqual({
      model: "gpt-5.6-sol",
      model_reasoning_effort: "high",
      service_tier: "fast",
      features: { fast_mode: true },
    });
    expect(configOptions).toEqual([]);
    expect(meta[0]?.commandNotes).toContain(
      "Requested ACPX model: gpt-5.6-sol (set via CODEX_CONFIG at startup).",
    );
  });

  it("forwards arbitrary Codex model IDs verbatim without picker-dependent session config", async () => {
    const arbitraryModel = "gpt-999-test-does-not-exist";
    const { configOptions, meta } = await runExecutor({
      agent: "codex",
      model: arbitraryModel,
      reasoningEffort: "xhigh",
      fastMode: true,
    });

    const codexConfig = JSON.parse(
      String((meta[0]?.env as Record<string, string>).CODEX_CONFIG),
    ) as Record<string, unknown>;
    expect(codexConfig.model).toBe(arbitraryModel);
    expect(codexConfig.model_reasoning_effort).toBe("xhigh");
    expect(configOptions).toEqual([]);
  });

  it("merges user CODEX_CONFIG while runtime model settings win", async () => {
    const { meta } = await runExecutor({
      agent: "codex",
      model: "gpt-runtime",
      fastMode: true,
      env: {
        CODEX_CONFIG: JSON.stringify({
          model: "gpt-user",
          approval_policy: "never",
          features: { experimental_feature: true, fast_mode: false },
        }),
      },
    });

    expect(JSON.parse(String((meta[0]?.env as Record<string, string>).CODEX_CONFIG))).toEqual({
      model: "gpt-runtime",
      approval_policy: "never",
      service_tier: "fast",
      features: { experimental_feature: true, fast_mode: true },
    });
  });

  it("warns when runtime settings replace malformed user CODEX_CONFIG", async () => {
    const { logs, meta } = await runExecutor({
      agent: "codex",
      model: "gpt-runtime",
      env: { CODEX_CONFIG: "not-json" },
    });

    expect(JSON.parse(String((meta[0]?.env as Record<string, string>).CODEX_CONFIG))).toEqual({
      model: "gpt-runtime",
    });
    expect(logs).toContainEqual({
      stream: "stderr",
      text: "[paperclip] Ignoring invalid user CODEX_CONFIG while applying runtime Codex settings; expected a JSON object.\n",
    });
  });

  it("keeps Claude startup model handling and Gemini session config handling unchanged", async () => {
    const claude = await runExecutor({ agent: "claude", model: "claude-opus-4-7" });
    expect((claude.meta[0]?.env as Record<string, string>).ANTHROPIC_MODEL).toBe(
      "claude-opus-4-7",
    );
    expect(claude.configOptions).toEqual([]);

    const gemini = await runExecutor({
      agent: "gemini",
      model: "gemini-2.5-pro",
      thinkingEffort: "high",
    });
    expect(gemini.configOptions).toEqual([
      { key: "model", value: "gemini-2.5-pro" },
      { key: "effort", value: "high" },
    ]);
  });

  it("does not inject CODEX_CONFIG or session config when Codex overrides are absent", async () => {
    const { configOptions, meta } = await runExecutor({ agent: "codex" });

    expect((meta[0]?.env as Record<string, string>).CODEX_CONFIG).toBeUndefined();
    expect(configOptions).toEqual([]);
  });

  it("includes Paperclip env and API access notes in the ACPX prompt without leaking the token", async () => {
    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js" },
      {
        authToken: "runtime-secret-token",
        context: {
          taskId: "issue-1",
          wakeReason: "issue_assigned",
          paperclipWake: {
            reason: "issue_assigned",
            issue: { id: "issue-1", identifier: "TEST-1" },
          },
        },
      },
    );

    const prompt = String(meta[0]?.prompt ?? "");
    const promptMetrics = meta[0]?.promptMetrics as Record<string, number> | undefined;
    expect(prompt).toContain("Paperclip runtime note:");
    expect(prompt).toContain("PAPERCLIP_AGENT_ID");
    expect(prompt).toContain("PAPERCLIP_API_KEY");
    expect(prompt).toContain("PAPERCLIP_WAKE_PAYLOAD_JSON");
    expect(prompt).toContain("Paperclip API access note:");
    expect(prompt).toContain('PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"');
    expect(prompt).toContain("$PAPERCLIP_API_BASE/api/agents/me");
    expect(prompt).toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID");
    expect(prompt).toContain("X-Paperclip-Run-Id");
    expect(prompt).not.toContain("$PAPERCLIP_API_URL/api/");
    expect(prompt).not.toContain("/api/issues/{id}");
    expect(prompt).not.toContain("-d '{...}'");
    expect(prompt).not.toContain("runtime-secret-token");
    expect(promptMetrics?.runtimeNoteChars).toBeGreaterThan(0);
  });

  it("does not show a scoped issue API command when the task id is unavailable", async () => {
    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js" },
      { authToken: "runtime-secret-token" },
    );

    const prompt = String(meta[0]?.prompt ?? "");
    expect(prompt).toContain("Paperclip API access note:");
    expect(prompt).toContain("Use a real issue id from the current context before making issue write requests.");
    expect(prompt).not.toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID");
  });

  it("emits ACP text deltas as stdout transcript records", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield {
              type: "text_delta",
              text: "streamed hello",
              stream: "output",
              tag: "agent_message_chunk",
            };
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-streaming-text-delta",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(logs).toContainEqual({
      stream: "stdout",
      text: `${JSON.stringify({
        type: "acpx.text_delta",
        text: "streamed hello",
        channel: "output",
        tag: "agent_message_chunk",
      })}\n`,
    });
  });

  it("captures per-run usage, cost deltas, and billing identity from the ACP runtime", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const logs: Array<{ stream: string; text: string }> = [];
    let statusCalls = 0;
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        getStatus: async () => {
          statusCalls += 1;
          return statusCalls === 1
            ? { usage: { cost: { amount: 0.4, currency: "USD" } } }
            : {
                usage: {
                  cumulative: {
                    inputTokens: 120,
                    outputTokens: 4500,
                    cachedReadTokens: 900,
                    cachedWriteTokens: 30,
                  },
                  cost: { amount: 1.15, currency: "USD" },
                },
              };
        },
        startTurn: () => ({
          events: (async function* () {
            yield {
              type: "status",
              text: "usage",
              tag: "usage_update",
              used: 5550,
              size: 200000,
              cost: { amount: 1.1, currency: "USD" },
            };
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
      resolveBillingIdentity: () => ({ provider: "anthropic", biller: "anthropic", billingType: "api" }),
    });

    const result = await execute({
      runId: "run-usage-capture",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(statusCalls).toBe(2);
    // Cache-write tokens count as input tokens; cached reads stay separate.
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 4500, cachedInputTokens: 900 });
    expect(result.usageBasis).toBe("per_run");
    // Agent-reported cost is cumulative; this run pays the delta.
    expect(result.costUsd).toBeCloseTo(0.75);
    expect(result.provider).toBe("anthropic");
    expect(result.biller).toBe("anthropic");
    expect(result.billingType).toBe("api");
    expect((result.resultJson as Record<string, unknown>)?.cumulativeCostUsd).toBeCloseTo(1.15);
    expect((result.resultJson as Record<string, unknown>)?.usage).toEqual({
      inputTokens: 120,
      outputTokens: 4500,
      cachedReadTokens: 900,
      cachedWriteTokens: 30,
    });
    const statusLine = logs.find((entry) => entry.text.includes('"acpx.status"'));
    expect(statusLine?.text).toContain('"cost"');
  });

  it("falls back to usage_update events when the runtime lacks getStatus", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield {
              type: "status",
              text: "usage",
              tag: "usage_update",
              cost: { amount: 0.31, currency: "USD" },
              breakdown: { inputTokens: 40, outputTokens: 700, cachedReadTokens: 60 },
            };
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-usage-event-fallback",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 700, cachedInputTokens: 60 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBeCloseTo(0.31);
    expect(result.provider).toBe("acpx");
    expect(result.billingType).toBe("unknown");
  });

  it.skipIf(process.platform === "win32")("materializes ACPX Claude skills without symlinked descendants", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const skill = await createSkill(skillRoot, "danger");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(skill.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(skill.source, "leak-dir"));

    const stateDir = path.join(root, "state");
    const { meta } = await runExecutor({
      agent: "claude",
      stateDir,
      paperclipRuntimeSkills: [skill],
      paperclipSkillSync: { desiredSkills: [skill.key] },
    });

    const mountedRoot = await onlyChildDir(path.join(stateDir, "runtime-skills", "claude"));
    const skillsHome = path.join(mountedRoot, ".claude", "skills");
    const materializedSkill = path.join(skillsHome, skill.runtimeName);
    expect(await fs.readFile(path.join(materializedSkill, "SKILL.md"), "utf8")).toContain("# danger");
    expect(await pathExists(path.join(materializedSkill, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(materializedSkill, "leak-dir"))).toBe(false);
    expect(String(meta[0]?.prompt ?? "")).toContain(`Skill root: ${skillsHome}`);
  });

  it.skipIf(process.platform === "win32")("revokes removed ACPX Codex skills and skips symlinked descendants", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const outsideRoot = path.join(root, "outside");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "do not expose", "utf8");
    const keep = await createSkill(skillRoot, "keep");
    const remove = await createSkill(skillRoot, "remove");
    await fs.symlink(path.join(outsideRoot, "secret.txt"), path.join(keep.source, "leak.txt"));
    await fs.symlink(outsideRoot, path.join(keep.source, "leak-dir"));

    const baseConfig = {
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [keep, remove],
    };

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key, remove.key] },
    });
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName, "SKILL.md"))).toBe(true);

    await runExecutor({
      ...baseConfig,
      paperclipSkillSync: { desiredSkills: [keep.key] },
    });

    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak.txt"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", keep.runtimeName, "leak-dir"))).toBe(false);
    expect(await pathExists(path.join(codexHome, "skills", remove.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("removes legacy ACPX Codex skill symlinks when a skill is no longer desired", async () => {
    const root = await makeTempRoot();
    const skillRoot = path.join(root, "skills");
    const codexHome = path.join(root, "codex-home");
    const legacy = await createSkill(skillRoot, "legacy");
    const skillsHome = path.join(codexHome, "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    await fs.symlink(legacy.source, path.join(skillsHome, legacy.runtimeName));

    await runExecutor({
      agent: "codex",
      stateDir: path.join(root, "state"),
      env: { CODEX_HOME: codexHome },
      paperclipRuntimeSkills: [legacy],
      paperclipSkillSync: { desiredSkills: [] },
    });

    expect(await pathExists(path.join(skillsHome, legacy.runtimeName))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("replaces stale managed Codex auth files with source symlinks", async () => {
    const root = await makeTempRoot();
    const sourceCodexHome = path.join(root, "source-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const paperclipInstanceId = "test-instance";
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      paperclipInstanceId,
      "companies",
      "company-1",
      "codex-home",
    );
    await fs.mkdir(sourceCodexHome, { recursive: true });
    await fs.mkdir(managedCodexHome, { recursive: true });
    const sourceAuth = path.join(sourceCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");
    await fs.writeFile(sourceAuth, "{\"source\":true}", "utf8");
    await fs.writeFile(managedAuth, "{\"stale\":true}", "utf8");

    const previousCodexHome = process.env.CODEX_HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    try {
      process.env.CODEX_HOME = sourceCodexHome;
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = paperclipInstanceId;
      await runExecutor({
        agent: "codex",
        stateDir: path.join(root, "state"),
        paperclipRuntimeSkills: [],
        paperclipSkillSync: { desiredSkills: [] },
      });
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    }

    const authStat = await fs.lstat(managedAuth);
    expect(authStat.isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(managedAuth), await fs.readlink(managedAuth))).toBe(sourceAuth);
  });

  it("uses direct registry commands and per-session env across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    const first = await runExecutor(
      { ...baseConfig, agent: "custom-a" },
      { authToken: "old-key" },
    );
    const second = await runExecutor(
      { ...baseConfig, agent: "custom-b" },
      { authToken: "new-key" },
    );

    expect(
      (first.runtimeOptions[0]!.agentRegistry as { resolve(name: string): string }).resolve(
        "custom-a",
      ),
    ).toBe("node ./fake-acp.js");
    expect(
      (second.sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env
        .PAPERCLIP_API_KEY,
    ).toBe("new-key");
    await expect(fs.access(path.join(stateDir, "wrappers"))).rejects.toThrow();
  });

  it("forwards resolved adapter env through session options without overriding runtime vars", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const { sessionInputs } = await runExecutor(
      {
        agentCommand: "node ./fake-acp.js",
        stateDir,
        env: {
          OOGA_BOOGA_123: "plain-value",
          // Server-resolved secret_ref values arrive here as plain strings.
          OPENROUTER_API_KEY: "resolved-secret-value",
          // Reserved-namespace config keys must not clobber runtime identity/wake.
          PAPERCLIP_TASK_ID: "attacker-issue",
          // PAPERCLIP_API_KEY is never accepted from config.
          PAPERCLIP_API_KEY: "config-key",
          // A PAPERCLIP_*-named key the harness does not assign flows through.
          PAPERCLIP_CLOUD_PROVIDER_TOKEN: "cloud-token",
        },
      },
      {
        authToken: "runtime-secret-token",
        context: { taskId: "issue-real", wakeReason: "issue_assigned" },
      },
    );
    const env = (sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env;
    expect(env.OOGA_BOOGA_123).toBe("plain-value");
    expect(env.OPENROUTER_API_KEY).toBe("resolved-secret-value");
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-real");
    expect(env.PAPERCLIP_API_KEY).toBe("runtime-secret-token");
    expect(env.PAPERCLIP_CLOUD_PROVIDER_TOKEN).toBe("cloud-token");
  });

  it("busts the session fingerprint when resolved adapter env changes but not across wakes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = { agentCommand: "node ./fake-acp.js", stateDir };

    const first = await runExecutor(
      { ...baseConfig, env: { OPENROUTER_API_KEY: "value-1" } },
      { context: { taskId: "issue-1", wakeReason: "issue_assigned" } },
    );
    const changedEnv = await runExecutor(
      { ...baseConfig, env: { OPENROUTER_API_KEY: "value-2" } },
      { context: { taskId: "issue-1", wakeReason: "issue_assigned" } },
    );
    const sameEnvNewWake = await runExecutor(
      { ...baseConfig, env: { OPENROUTER_API_KEY: "value-1" } },
      { context: { taskId: "issue-1", wakeReason: "comment", wakeCommentId: "c-9" } },
    );

    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;

    // A changed forwarded env value invalidates warm-handle / session reuse so
    // the next launch sources the latest env.
    expect(fp(first)).toBeDefined();
    expect(fp(changedEnv)).not.toBe(fp(first));
    // A new heartbeat with the same config env keeps the fingerprint stable, so
    // per-wake PAPERCLIP_* churn does not needlessly reset the session.
    expect(fp(sameEnvNewWake)).toBe(fp(first));
  });

  it("busts the session fingerprint when a stable configured PAPERCLIP_* value rotates", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = { agentCommand: "node ./fake-acp.js", stateDir };

    // A configured PAPERCLIP_*-named value the harness does not assign (e.g. a
    // cloud provider token binding) is stable per-run config: rotating it must
    // invalidate a warm/resumable session so the next launch sources the new
    // value, even across an otherwise-identical wake context.
    const context = { taskId: "issue-1", wakeReason: "issue_assigned" };
    const withKey = await runExecutor(
      { ...baseConfig, env: { PAPERCLIP_CLOUD_PROVIDER_TOKEN: "explicit-key-1" } },
      { context },
    );
    const rotatedKey = await runExecutor(
      { ...baseConfig, env: { PAPERCLIP_CLOUD_PROVIDER_TOKEN: "explicit-key-2" } },
      { context },
    );

    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;

    expect(fp(withKey)).toBeDefined();
    expect(fp(rotatedKey)).not.toBe(fp(withKey));
  });

  it("shapes ACPX session env for remote execution identities", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "local");
    const remoteCwd = "/workspace/remote";
    const { sessionInputs } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", cwd: localCwd, stateDir: path.join(root, "state") },
      { context: { paperclipWorkspace: { cwd: localCwd, workspaceWorktreePath: localCwd } }, executionTarget: { kind: "remote", transport: "ssh", remoteCwd } },
    );
    const env = (sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env;
    expect(env.PAPERCLIP_WORKSPACE_CWD).toBe(localCwd);
  });

  it("does not materialize credential wrapper scripts", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    await runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js", stateDir });
    await expect(fs.access(path.join(stateDir, "wrappers"))).rejects.toThrow();
  });

  it("keeps concurrent credentials isolated in their session options", async () => {
    const [first, second] = await Promise.all([
      runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js" }, { authToken: "first" }),
      runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js" }, { authToken: "second" }),
    ]);
    expect(
      (first.sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env
        .PAPERCLIP_API_KEY,
    ).toBe("first");
    expect(
      (second.sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env
        .PAPERCLIP_API_KEY,
    ).toBe("second");
  });

  it("enriches acpx.error diagnostics and child stderr when ensureSession rejects", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const runStderrDir = path.join(stateDir, "run-stderr");
    await fs.mkdir(runStderrDir, { recursive: true });
    const stderrTail = "claude-agent-acp: SDK init failed (auth missing)";
    await fs.writeFile(path.join(runStderrDir, "run-1.log"), `${stderrTail}\n`, "utf8");

    class FakeAcpRuntimeError extends Error {
      readonly code = "ACP_SESSION_INIT_FAILED";
      readonly cause: Error;
      readonly retryable = false;
      constructor(message: string, cause: Error) {
        super(message);
        this.name = "AcpRuntimeError";
        this.cause = cause;
      }
    }

    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => {
          throw new FakeAcpRuntimeError(
            "session/new failed: backend rejected initialize",
            new Error("upstream timeout"),
          );
        },
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
      },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_session_init_failed");
    const meta = result.errorMeta ?? {};
    expect(meta.errorName).toBe("AcpRuntimeError");
    expect(meta.acpCode).toBe("ACP_SESSION_INIT_FAILED");
    expect(meta.causeMessage).toBe("upstream timeout");
    expect(meta.retryable).toBe(false);
    expect(typeof meta.stackPreview).toBe("string");
    expect(meta.phase).toBe("ensure_session");

    const errorLogLine = logs.find((entry) => entry.stream === "stdout" && entry.text.includes("\"type\":\"acpx.error\""));
    expect(errorLogLine).toBeTruthy();
    const errorPayload = JSON.parse(errorLogLine!.text.trim());
    expect(errorPayload.phase).toBe("ensure_session");
    expect(errorPayload.errorName).toBe("AcpRuntimeError");
    expect(errorPayload.acpCode).toBe("ACP_SESSION_INIT_FAILED");
    expect(errorPayload.causeMessage).toBe("upstream timeout");
    expect(errorPayload.childStderrTail).toContain("SDK init failed");

    const stderrLog = logs.find((entry) => entry.stream === "stderr" && entry.text.includes("ACPX child stderr tail"));
    expect(stderrLog).toBeTruthy();
    expect(stderrLog!.text).toContain(stderrTail);
  });

  it("configures in-process child stderr capture without forcing verbose mode", async () => {
    const root = await makeTempRoot();
    const { runtimeOptions } = await runExecutor({ agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") });
    expect(runtimeOptions[0]!.verbose).toBe(false);
    expect(runtimeOptions[0]!.onAgentStderr).toBeTypeOf("function");
  });

  it("starts sandbox ACP process sessions in the remote execution cwd", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });

    let sessionPayload: Record<string, unknown> | null = null;
    const runner = createLocalSandboxRunner(
      (input: { args?: string[]; env?: Record<string, string> }) => {
        if (input.env?.PAPERCLIP_SANDBOX_EXEC_CHANNEL === "bridge") {
          const script = input.args?.[1] ?? "";
          const match = script.match(/PAPERCLIP_PROCESS_SESSION_COMMAND_B64='([^']+)'/);
          if (match) {
            sessionPayload = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as Record<string, unknown>;
          }
        }
      },
    );

    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      {
        authToken: "real-run-jwt",
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "fake-plugin",
          remoteCwd,
          runner,
        },
      },
    );

    expect(sessionPayload).toMatchObject({
      command: "sh",
      args: ["-lc", "exec node ./fake-acp.js"],
      cwd: remoteCwd,
    });
    const payloadEnv = ((sessionPayload as Record<string, unknown> | null)?.env ?? {}) as Record<string, unknown>;
    expect(payloadEnv).toMatchObject({
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    });
    expect(String(payloadEnv.PAPERCLIP_API_URL ?? "")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
    expect(payloadEnv.PAPERCLIP_API_KEY).toBeTruthy();
    expect(payloadEnv.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
  });

  it("routes child stderr in-process while keeping the unfiltered run log", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const execute = createAcpxEngineExecutor({
      createRuntime: (options) => {
        runtimeOptions = options;
        return buildRuntime() as never;
      },
    });
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await execute({
        runId: "run-nes-close-1",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
        context: {},
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      runtimeOptions?.onAgentStderr?.("Error handling request { method: 'nes/cl");
      runtimeOptions?.onAgentStderr?.("ose' } { code: -32601 }\n");
      runtimeOptions?.onAgentStderr?.("some genuine crash: TypeError: x is not a function\n");
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join("")).not.toContain("nes/close");
    expect(writes.join("")).toContain("some genuine crash");
    const runLog = await fs.readFile(path.join(stateDir, "run-stderr", "run-nes-close-1.log"), "utf8");
    expect(runLog).toContain("nes/close");
    expect(runLog).toContain("some genuine crash");
  });

  it("routes reused warm-runtime stderr to the current run log", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const warmHandles = new Map();
    let runtimeOptions: AcpRuntimeOptions | undefined;
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: (options) => {
        runtimeOptions = options;
        return buildRuntime() as never;
      },
    });
    const config = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      mode: "persistent",
      warmHandleIdleMs: 60_000,
    };
    const first = await execute({
      runId: "run-warm-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);
    const second = await execute({
      runId: "run-warm-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);
    expect(second.exitCode).toBe(0);
    runtimeOptions?.onAgentStderr?.("current-run-stderr\n");
    await expect(fs.readFile(path.join(stateDir, "run-stderr", "run-warm-1.log"), "utf8")).rejects.toThrow();
    await expect(fs.readFile(path.join(stateDir, "run-stderr", "run-warm-2.log"), "utf8")).resolves.toContain("current-run-stderr");
  });

  it("passes Paperclip env through ACPX session options instead of process.env", async () => {
    let observedSessionEnv: Record<string, string> | undefined;
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async (input: { sessionOptions?: { env?: Record<string, string> } }) => {
          observedSessionEnv = input.sessionOptions?.env;
          return { backendSessionId: "backend-session", agentSessionId: "agent-session", runtimeSessionName: "runtime-session" };
        },
        startTurn: () => ({
          events: (async function* () { yield { type: "done", stopReason: "end_turn" }; })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    try {
      delete process.env.PAPERCLIP_API_KEY;
      const result = await execute({
        runId: "run-1",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js" },
        context: {},
        authToken: "runtime-key",
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      expect(observedSessionEnv?.PAPERCLIP_API_KEY).toBe("runtime-key");
      expect(process.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });

  it("writes a Paperclip-managed .claude/settings.local.json for the claude agent so it can reach the Paperclip API", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { meta } = await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd, agentHome: path.join(root, "agent-home") } } },
    );

    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      permissions?: {
        allow?: unknown;
        additionalDirectories?: unknown;
        defaultMode?: unknown;
      };
    };
    expect(written.permissions?.defaultMode).toBe("default");
    const allow = written.permissions?.allow;
    expect(Array.isArray(allow)).toBe(true);
    expect(allow).toContain("Bash(curl:*)");
    expect(allow).toContain(`Bash(${cwd}/scripts/paperclip-issue-update.sh:*)`);
    const additionalDirectories = written.permissions?.additionalDirectories as string[] | undefined;
    expect(Array.isArray(additionalDirectories)).toBe(true);
    expect(additionalDirectories).toContain(stateDir);
    expect(additionalDirectories).toContain(path.join(root, "agent-home"));

    const note = (meta[0]?.commandNotes as string[] | undefined)?.find((entry) =>
      entry.includes("Paperclip-managed Claude settings"),
    );
    expect(note).toBeTruthy();
  });

  it("merges Paperclip allowlist into an existing .claude/settings.local.json without losing user entries", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify(
        {
          statusLine: { type: "command", command: "preserve-me" },
          permissions: {
            allow: ["Bash(npm test:*)"],
            additionalDirectories: ["/Users/example/custom"],
            defaultMode: "acceptEdits",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    const written = JSON.parse(
      await fs.readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"),
    ) as {
      statusLine?: unknown;
      permissions?: {
        allow?: string[];
        additionalDirectories?: string[];
        defaultMode?: string;
      };
    };
    expect(written.statusLine).toEqual({ type: "command", command: "preserve-me" });
    expect(written.permissions?.defaultMode).toBe("acceptEdits");
    expect(written.permissions?.allow).toContain("Bash(npm test:*)");
    expect(written.permissions?.allow).toContain("Bash(curl:*)");
    expect(written.permissions?.additionalDirectories).toContain("/Users/example/custom");
    expect(written.permissions?.additionalDirectories).toContain(stateDir);
  });

  it("overrides a user-supplied dontAsk defaultMode so ACPX can route Bash through canUseTool", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "dontAsk" } }, null, 2),
      "utf8",
    );

    const { meta } = await runExecutor(
      { agent: "claude", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    const written = JSON.parse(
      await fs.readFile(path.join(cwd, ".claude", "settings.local.json"), "utf8"),
    ) as { permissions?: { defaultMode?: string } };
    expect(written.permissions?.defaultMode).toBe("default");

    const overrideNote = (meta[0]?.commandNotes as string[] | undefined)?.find((entry) =>
      entry.includes("overrode user dontAsk"),
    );
    expect(overrideNote).toBeTruthy();
  });

  it("opts the claude agent into ACPX runtime verbose logs but leaves codex/custom agents quiet", async () => {
    const root = await makeTempRoot();
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const verboseByAgent: Record<string, boolean | undefined> = {};
    for (const agent of ["claude", "codex", "custom"] as const) {
      const runtimeOptions: AcpRuntimeOptions[] = [];
      const execute = createAcpxEngineExecutor({
        createRuntime: (options) => {
          runtimeOptions.push(options as AcpRuntimeOptions);
          return buildRuntime() as never;
        },
      });
      const result = await execute({
        runId: `run-${agent}`,
        agent: { id: `agent-${agent}`, companyId: "company-1" },
        runtime: {},
        config:
          agent === "custom"
            ? { agent, agentCommand: "node ./fake-acp.js", stateDir: path.join(root, `state-${agent}`), cwd }
            : { agent, stateDir: path.join(root, `state-${agent}`), cwd },
        context: { paperclipWorkspace: { cwd } },
        onLog: async () => {},
        onMeta: async () => {},
      } as never);
      expect(result.exitCode).toBe(0);
      verboseByAgent[agent] = (runtimeOptions[0] as { verbose?: boolean } | undefined)?.verbose;
    }

    expect(verboseByAgent.claude).toBe(true);
    expect(verboseByAgent.codex).toBe(false);
    expect(verboseByAgent.custom).toBe(false);
  });

  it("does not touch .claude/settings.local.json for the codex agent", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    await runExecutor(
      { agent: "codex", stateDir, cwd },
      { context: { paperclipWorkspace: { cwd } } },
    );

    expect(await pathExists(path.join(cwd, ".claude", "settings.local.json"))).toBe(false);
  });

  it("changes the ACPX session fingerprint when the resolved secret manifest rotates", async () => {
    const root = await makeTempRoot();
    const baseConfig = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
    };

    const first = await runExecutor(baseConfig, {
      context: {
        paperclipSecrets: {
          manifest: [
            {
              configPath: "env.API_TOKEN",
              envKey: "API_TOKEN",
              secretId: "secret-1",
              bindingId: "binding-1",
              secretKey: "api-token",
              version: 1,
              provider: "local_encrypted",
            },
          ],
        },
      },
    });
    const second = await runExecutor(baseConfig, {
      context: {
        paperclipSecrets: {
          manifest: [
            {
              configPath: "env.API_TOKEN",
              envKey: "API_TOKEN",
              secretId: "secret-1",
              bindingId: "binding-1",
              secretKey: "api-token",
              version: 2,
              provider: "local_encrypted",
            },
          ],
        },
      },
    });

    expect(first.result.sessionParams?.configFingerprint).toBeTypeOf("string");
    expect(second.result.sessionParams?.configFingerprint).toBeTypeOf("string");
    expect(first.result.sessionParams?.configFingerprint).not.toBe(second.result.sessionParams?.configFingerprint);
  });

  it("injects runtime MCP servers and fingerprints their identity without persisting bearer tokens", async () => {
    const root = await makeTempRoot();
    const baseConfig = {
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
    };
    const server = {
      name: "github",
      url: "https://paperclip.example/api/tool-gateway/gateways/github/mcp",
      connectionId: "connection-1",
    };
    const first = await runExecutor(baseConfig, {
      runtimeMcp: { getServers: () => [{ ...server, token: "token-one" }] },
    });
    const rotatedToken = await runExecutor(baseConfig, {
      runtimeMcp: { getServers: () => [{ ...server, token: "token-two" }] },
    });
    const changedSet = await runExecutor(baseConfig, {
      runtimeMcp: {
        getServers: () => [{ ...server, connectionId: "connection-2", token: "token-two" }],
      },
    });

    expect(first.runtimeOptions[0]?.mcpServers).toEqual([{
      type: "http",
      name: "github",
      url: server.url,
      headers: [{ name: "Authorization", value: "Bearer token-one" }],
    }]);
    expect(first.result.sessionParams?.mcpServers).toEqual([{
      name: "github",
      url: server.url,
      connectionId: "connection-1",
    }]);
    expect(JSON.stringify(first.result.sessionParams)).not.toContain("token-one");
    expect(first.result.sessionParams?.configFingerprint).toBe(rotatedToken.result.sessionParams?.configFingerprint);
    expect(first.result.sessionParams?.configFingerprint).not.toBe(changedSet.result.sessionParams?.configFingerprint);
  });
});

describe("findAncestorBin", () => {
  async function writeFakeBin(dir: string, name: string) {
    const binDir = path.join(dir, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, name);
    await fs.writeFile(binPath, "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });
    return binPath;
  }

  it("finds the binary in the start directory's own node_modules/.bin", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    const expectedBin = await writeFakeBin(packageDir, "claude-agent-acp");

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBe(expectedBin);
  });

  it("finds the binary hoisted to an ancestor node_modules/.bin", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    const expectedBin = await writeFakeBin(root, "claude-agent-acp");

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBe(expectedBin);
  });

  it("returns null when the binary is not present in any ancestor", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });

    const resolved = await findAncestorBin(packageDir, "claude-agent-acp");

    expect(resolved).toBeNull();
  });

  it("terminates at the filesystem root instead of looping forever", async () => {
    const resolved = await findAncestorBin("/", "definitely-not-a-real-bin-name-xyz");
    expect(resolved).toBeNull();
  });
});

describe("gemini ACP flag selection", () => {
  it("parses semantic version parts from gemini --version output", () => {
    expect(parseGeminiVersionParts("0.30.0")).toEqual([0, 30, 0]);
    expect(parseGeminiVersionParts("gemini-cli v1.2.3\n")).toEqual([1, 2, 3]);
    expect(parseGeminiVersionParts("no version here")).toBeNull();
    expect(parseGeminiVersionParts(null)).toBeNull();
  });

  it("keeps --acp for gemini >= 0.33.0 and unknown versions", () => {
    expect(geminiVersionSupportsNativeAcpFlag([0, 33, 0])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag([0, 34, 1])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag([1, 0, 0])).toBe(true);
    expect(geminiVersionSupportsNativeAcpFlag(null)).toBe(true);
    expect(rewriteGeminiAcpFlagForVersion("gemini --acp", [0, 33, 0])).toBe("gemini --acp");
  });

  it("downgrades --acp to --experimental-acp for gemini < 0.33.0", () => {
    expect(geminiVersionSupportsNativeAcpFlag([0, 30, 0])).toBe(false);
    expect(geminiVersionSupportsNativeAcpFlag([0, 32, 9])).toBe(false);
    expect(rewriteGeminiAcpFlagForVersion("gemini --acp", [0, 30, 0])).toBe("gemini --experimental-acp");
    expect(rewriteGeminiAcpFlagForVersion("/opt/bin/gemini --acp", [0, 30, 0])).toBe(
      "/opt/bin/gemini --experimental-acp",
    );
  });

  async function writeFakeGemini(binDir: string, version: string) {
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, "gemini");
    await fs.writeFile(binPath, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  }

  function pathWithFakeBin(binDir: string): string {
    return [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  }

  it("registers the gemini multi-word command directly", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.33.0");
    const { runtimeOptions } = await runExecutor({ agent: "gemini", stateDir: path.join(root, "state"), env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) } });
    expect((runtimeOptions[0]!.agentRegistry as { resolve(name: string): string }).resolve("gemini")).toBe("gemini --acp");
  });

  it("downgrades the registered gemini command when the local CLI predates --acp", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.30.0");
    const { runtimeOptions } = await runExecutor({ agent: "gemini", stateDir: path.join(root, "state"), env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) } });
    expect((runtimeOptions[0]!.agentRegistry as { resolve(name: string): string }).resolve("gemini")).toBe("gemini --experimental-acp");
  });

  it("applies the 4h sandbox backstop when timeoutSec is unset on a sandbox execution target", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd },
      {
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "acme-sandbox",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: cwd,
        },
      },
    );

    // The sandbox default flows into the ACPX runtime wall-clock timer.
    expect(runtimeOptions[0]?.timeoutMs).toBe(DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000);
    // The effective timeout and its source are stated at run start so a later
    // timeout is diagnosable from the run log alone.
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine).toBeTruthy();
    expect(startLine!.text).toContain(
      `[paperclip] Adapter execution timeout: timeoutSec=${DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC} ` +
        "(sandbox default; set adapterConfig.timeoutSec to override).",
    );
  });

  it("keeps local execution unlimited by default and logs the unlimited timeout", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      cwd,
    });

    expect(runtimeOptions[0]?.timeoutMs).toBeUndefined();
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine).toBeTruthy();
    expect(startLine!.text).toContain("Adapter execution timeout: none");
  });

  it("prefers a configured timeoutSec over the sandbox default", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const { logs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: 90 },
      {
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          remoteCwd: cwd,
        },
      },
    );

    expect(runtimeOptions[0]?.timeoutMs).toBe(90 * 1000);
    const startLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine!.text).toContain(
      "Adapter execution timeout: timeoutSec=90 (configured via adapterConfig.timeoutSec; set adapterConfig.timeoutSec to override).",
    );
  });

  it("keeps the sandbox backstop for an explicit timeoutSec of 0 but honors a negative opt-out", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });
    const sandboxContext = {
      executionTarget: {
        kind: "remote",
        transport: "sandbox",
        remoteCwd: cwd,
      },
    };

    // The config UI persists the schema default of 0 for untouched fields, so
    // an explicit 0 cannot mean "no timeout" — it keeps the 4h backstop.
    const explicitZero = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: 0 },
      sandboxContext,
    );
    expect(explicitZero.runtimeOptions[0]?.timeoutMs).toBe(
      DEFAULT_REMOTE_SANDBOX_ADAPTER_TIMEOUT_SEC * 1000,
    );

    // A negative timeoutSec is the documented opt-out from any adapter
    // wall-clock timeout, sandbox targets included.
    const negativeOptOut = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd, timeoutSec: -1 },
      sandboxContext,
    );
    expect(negativeOptOut.runtimeOptions[0]?.timeoutMs).toBeUndefined();
    const startLine = negativeOptOut.logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("Adapter execution timeout:"),
    );
    expect(startLine!.text).toContain(
      "Adapter execution timeout: none (explicitly disabled via adapterConfig.timeoutSec; " +
        "set it to a positive value to add one).",
    );
  });

  it("reports a self-describing timeout error when the wall-clock timer kills a turn", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const cancelReasons: string[] = [];
    let releaseTurn: (() => void) | null = null;
    const turnCancelled = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          // Never yields on its own: only the Paperclip wall-clock timer's
          // cancel unblocks the turn, simulating a hung run.
          events: (async function* () {
            await turnCancelled;
          })(),
          result: turnCancelled.then(() => ({ status: "cancelled", stopReason: "cancelled" })),
          cancel: async ({ reason }: { reason: string }) => {
            cancelReasons.push(reason);
            releaseTurn?.();
          },
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-timeout-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd,
        timeoutSec: 1,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    const expectedMessage =
      "Run exceeded the adapter execution timeout (timeoutSec=1, configured via adapterConfig.timeoutSec). " +
      "Set adapterConfig.timeoutSec to raise it.";
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("acpx_timeout");
    expect(result.errorMessage).toBe(expectedMessage);
    expect(cancelReasons).toContain(expectedMessage);
  }, 15_000);
});

describe("summarizeAcpxTurnUsage", () => {
  it("uses the post-turn amount alone when the cumulative cost counter reset", () => {
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cost: { amount: 2.5, currency: "USD" } } },
      postStatus: {
        usage: {
          cumulative: { inputTokens: 10, outputTokens: 20 },
          cost: { amount: 0.3, currency: "USD" },
        },
      },
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.costUsd).toBeCloseTo(0.3);
    expect(summary.cumulativeCostUsd).toBeCloseTo(0.3);
  });

  it("ignores non-USD cost amounts", () => {
    const summary = summarizeAcpxTurnUsage({
      preStatus: null,
      postStatus: { usage: { cost: { amount: 4, currency: "EUR" } } },
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.costUsd).toBeNull();
    expect(summary.cumulativeCostUsd).toBeNull();
  });

  it("returns no usage when nothing was reported", () => {
    const summary = summarizeAcpxTurnUsage({
      preStatus: null,
      postStatus: null,
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.usage).toBeNull();
    expect(summary.costUsd).toBeNull();
  });
});

describe("summarizeAcpxTurnUsage no-report turns", () => {
  it("suppresses usage when the turn reported nothing and the persisted breakdown is unchanged", () => {
    const stale = { inputTokens: 10, outputTokens: 500, cachedReadTokens: 30 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: stale, cost: { amount: 0.5, currency: "USD" } } },
      postStatus: { usage: { cumulative: { ...stale }, cost: { amount: 0.5, currency: "USD" } } },
      eventBreakdown: null,
      eventCostUsd: null,
    });
    expect(summary.usage).toBeNull();
    expect(summary.usageDetail).toBeNull();
    expect(summary.costUsd).toBeCloseTo(0);
  });

  it("prefers current event usage when the persisted breakdown is stale", () => {
    const stale = { inputTokens: 10, outputTokens: 500, cachedReadTokens: 30 };
    const current = { inputTokens: 25, outputTokens: 75, cachedReadTokens: 5 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: stale } },
      postStatus: { usage: { cumulative: { ...stale } } },
      eventBreakdown: current,
      eventCostUsd: null,
    });
    expect(summary.usage).toEqual({
      inputTokens: 25,
      outputTokens: 75,
      cachedInputTokens: 5,
    });
    expect(summary.usageDetail).toMatchObject(current);
  });

  it("treats omitted and explicit zero fields as the same stale breakdown", () => {
    const current = { inputTokens: 25, outputTokens: 75, cachedReadTokens: 5 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: { inputTokens: 10, outputTokens: 500 } } },
      postStatus: {
        usage: {
          cumulative: {
            inputTokens: 10,
            outputTokens: 500,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
            thoughtTokens: 0,
            totalTokens: 0,
          },
        },
      },
      eventBreakdown: current,
      eventCostUsd: null,
    });
    expect(summary.usage).toEqual({
      inputTokens: 25,
      outputTokens: 75,
      cachedInputTokens: 5,
    });
  });

  it("does not reuse stale tokens when the turn reports cost only", () => {
    const stale = { inputTokens: 10, outputTokens: 500, cachedReadTokens: 30 };
    const summary = summarizeAcpxTurnUsage({
      preStatus: { usage: { cumulative: stale, cost: { amount: 0.5, currency: "USD" } } },
      postStatus: {
        usage: { cumulative: { ...stale }, cost: { amount: 0.5, currency: "USD" } },
      },
      eventBreakdown: null,
      eventCostUsd: 0.75,
    });
    expect(summary.usage).toBeNull();
    expect(summary.usageDetail).toBeNull();
    expect(summary.costUsd).toBeCloseTo(0.25);
    expect(summary.cumulativeCostUsd).toBeCloseTo(0.75);
  });
});

describe("ACPX engine remote sandbox staging seam (PR 1: workspace + cwd)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupRemoteSandbox() {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    // A file present only in the HOST worktree proves the workspace is shipped
    // into the sandbox: the local runner extracts the staged tar into remoteCwd.
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    const runner = createLocalSandboxRunner();
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner,
    };
    return { root, stateDir, localCwd, remoteCwd, executionTarget };
  }

  it("test_remote_buildRuntime_crosses_staging_seam", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const { sessionInputs } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    // Staging seam crossed exactly once, shipping the HOST worktree.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(1);
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    expect(stageArgs.workspaceLocalDir).toBe(localCwd);
    expect(stageArgs.target).toMatchObject({ kind: "remote", transport: "sandbox" });
    // No credential/home asset staged in PR 1 (that is PR 2's per-adapter seed).
    expect(stageArgs.assets ?? []).toEqual([]);
    expect(stageArgs.installCommand ?? null).toBeNull();

    // Both bridges receive the real (non-null) runtimeRootDir from staging.
    const paperclipArgs = vi.mocked(startAdapterExecutionTargetPaperclipBridge).mock.calls[0]![0];
    const processArgs = vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mock.calls[0]![0];
    expect(paperclipArgs.runtimeRootDir).toBeTruthy();
    expect(processArgs.runtimeRootDir).toBeTruthy();
    expect(String(paperclipArgs.runtimeRootDir)).toContain(".paperclip-runtime");
    expect(processArgs.runtimeRootDir).toBe(paperclipArgs.runtimeRootDir);

    // The workspace really landed in the sandbox workspace dir.
    await expect(fs.readFile(path.join(remoteCwd, "hello.txt"), "utf8")).resolves.toBe("hi");
    // And session/new is created on the in-sandbox workspace cwd.
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
  });

  it("test_remote_session_new_uses_in_sandbox_cwd", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const { sessionInputs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    // The ACP runtime + session/new both bind to the in-sandbox workspace dir,
    // not the HOST worktree path.
    expect(runtimeOptions[0]?.cwd).toBe(remoteCwd);
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
    expect(sessionInputs[0]?.cwd).not.toBe(localCwd);
  });

  it("test_remote_warm_handle_reused_after_cwd_change", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      createRuntime: () => buildRuntime(undefined, (input) => ensureInputs.push(input)) as never,
    });
    const base = {
      agent: { id: "agent-1", companyId: "company-1" },
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        mode: "persistent",
        warmHandleIdleMs: 60_000,
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
    };

    const first = await execute({ runId: "run-remote-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-remote-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Both runs resolve session/new to the in-sandbox cwd...
    expect(ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    // ...and the second run RESUMES the first session: fingerprint/compat/persist
    // all read the same in-sandbox `sessionCwd`, so a handle created with the
    // in-sandbox cwd is reused, not invalidated, after the HOST→sandbox cwd swap.
    expect(ensureInputs[1]?.resumeSessionId).toBe(first.sessionId);
  });

  it("test_local_foundation_unchanged", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const { sessionInputs, runtimeOptions } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
      cwd: localCwd,
    });

    // A local (non-remote) run never crosses the staging seam or starts a
    // bridge, and session/new stays on the HOST cwd — byte-identical to today.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).not.toHaveBeenCalled();
    expect(vi.mocked(startAdapterExecutionTargetPaperclipBridge)).not.toHaveBeenCalled();
    expect(vi.mocked(startAdapterExecutionTargetProcessSessionBridge)).not.toHaveBeenCalled();
    expect(sessionInputs[0]?.cwd).toBe(localCwd);
    expect(runtimeOptions[0]?.cwd).toBe(localCwd);
  });
});

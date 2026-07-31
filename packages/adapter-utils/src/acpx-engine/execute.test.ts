import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import type { AdapterExecutionContext, AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
import type { RuntimeStatusUpdate } from "../runtime-progress.js";
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
  type AcpxEngineExecutorOptions,
} from "./execute.js";
import { runChildProcess } from "../server-utils.js";

const execFileAsync = promisify(execFile);
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  if (ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON === undefined) delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
  else process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
  if (ORIGINAL_PAPERCLIP_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
  else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_PAPERCLIP_RUNTIME_API_URL;
  if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;
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
      return {
        backendSessionId: "backend-session",
        agentSessionId: "agent-session",
        runtimeSessionName: "runtime-session",
      };
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
    runId?: string;
    context?: Record<string, unknown>;
    executionTransport?: Record<string, unknown>;
    authToken?: string;
    executionTarget?: Record<string, unknown>;
    runtimeMcp?: AdapterRuntimeMcpAccess;
    createRuntime?: (options: Record<string, unknown>) => unknown;
    prepareRemoteManagedHome?: AcpxEngineExecutorOptions["prepareRemoteManagedHome"];
    startupTraceContext?: AdapterExecutionContext["startupTraceContext"];
  } = {},
) {
  delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
  delete process.env.PAPERCLIP_RUNTIME_API_URL;
  delete process.env.PAPERCLIP_API_URL;
  const runtimeOptions: Record<string, unknown>[] = [];
  const configOptions: Array<{ key: string; value: string }> = [];
  const sessionInputs: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
  const runtimeFactory = options.createRuntime;
  const execute = createAcpxEngineExecutor({
    ...(options.prepareRemoteManagedHome
      ? { prepareRemoteManagedHome: options.prepareRemoteManagedHome }
      : {}),
    createRuntime: (runtimeInput) => {
      runtimeOptions.push(runtimeInput as unknown as Record<string, unknown>);
      if (runtimeFactory) {
        return runtimeFactory(runtimeInput as unknown as Record<string, unknown>) as never;
      }
      return buildRuntime(
        ({ key, value }) => configOptions.push({ key, value }),
        (input) => sessionInputs.push(input),
      ) as never;
    },
  });

  const result = await execute({
    runId: options.runId ?? "run-1",
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
      startupTraceContext: options.startupTraceContext,
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
    onMeta: async (payload: unknown) => {
      meta.push(payload as Record<string, unknown>);
    },
    onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
      events.push(event);
    },
  } as never);

  expect(result.exitCode).toBe(0);
  return { logs, meta, events, runtimeOptions, configOptions, sessionInputs, result };
}

async function listWrapperRunDirs(stateDir: string): Promise<string[]> {
  return (await fs.readdir(path.join(stateDir, "wrappers"))).sort();
}

async function listWrapperFilesForRun(stateDir: string, runId: string): Promise<string[]> {
  return (await fs.readdir(path.join(stateDir, "wrappers", runId))).sort();
}

// A recording span, used only in tests. It captures the span name, the parent
// span (resolved from the explicit parent-context token), the attribute map,
// the terminal status, and whether the span ended. The engine treats it purely
// through the structural `StartupSpan` contract.
interface RecordingSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  parent: RecordingSpan | null;
  status: { code: number } | null;
  ended: boolean;
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}

// Build an in-memory startup trace context that records every span. It models
// the real OTel parenting contract: `startSpan(name, options, context)` reads
// the parent from the explicit `context` token that `contextWithSpan` produced,
// so a test asserts the exact parent of each child without an OTel package or
// ambient async-context propagation.
function createRecordingStartupTrace() {
  const spans: RecordingSpan[] = [];
  const traceContext = {
    tracer: {
      startSpan(
        name: string,
        options?: { attributes?: Record<string, string | number | boolean> },
        context?: unknown,
      ) {
        const parent =
          context && typeof context === "object" && "span" in context
            ? ((context as { span: RecordingSpan }).span ?? null)
            : null;
        const span: RecordingSpan = {
          name,
          attributes: { ...(options?.attributes ?? {}) },
          parent,
          status: null,
          ended: false,
          setAttribute(key: string, value: string | number | boolean) {
            span.attributes[key] = value;
          },
          setStatus(status: { code: number }) {
            span.status = { code: status.code };
          },
          end() {
            span.ended = true;
          },
        };
        spans.push(span);
        return span;
      },
    },
    contextWithSpan(span: unknown) {
      return { span };
    },
  } satisfies AdapterExecutionContext["startupTraceContext"];
  return { traceContext, spans };
}

// The closed span-attribute allowlist for a sandbox-start span (Phase 2 + 3).
// A test asserts every recorded attribute key is in this set, so a command,
// path, id, or error-text key can never ride a span.
const ALLOWED_STARTUP_SPAN_ATTRIBUTE_KEYS = new Set([
  "step",
  "provider",
  "roundTrips",
  "providerExecMs",
  "providerGetMs",
]);

describe("shared ACPX engine runtime behavior", () => {
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
    expect(prompt).toContain("text/html response body means the write was discarded");
    expect(prompt).toContain("returns HTTP 200 with text/html, the write still failed");
    expect(prompt).toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID");
    expect(prompt).toContain("-w '%{http_code}'");
    expect(prompt).toContain("$PAPERCLIP_TMPDIR/paperclip-write.json");
    expect(prompt).toContain("jq -e '.comment.id'");
    expect(prompt).toContain("jq check is required");
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

  it("skips unsupported reasoning_effort on resumed sessions and continues the run", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const logs: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    const setConfigInputs: Array<{ key: string; value: string }> = [];
    let startTurnCalls = 0;
    let runtimeCreations = 0;
    const execute = createAcpxEngineExecutor({
      createRuntime: () => {
        runtimeCreations += 1;
        return {
          ensureSession: async () => ({
            backendSessionId: "backend-session",
            agentSessionId: "agent-session",
            runtimeSessionName: "runtime-session",
          }),
          setConfigOption: async (input: { key: string; value: string }) => {
            setConfigInputs.push({ key: input.key, value: input.value });
            if (runtimeCreations > 1 && input.key === "reasoning_effort") {
              throw new Error(
                "ACP session paperclip:test does not advertise config option 'reasoning_effort'. Supported config options: mode, model.",
              );
            }
          },
          startTurn: () => {
            startTurnCalls += 1;
            return {
              events: (async function* () {
                yield { type: "done", stopReason: "end_turn" };
              })(),
              result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
              cancel: async () => {},
            };
          },
          close: async () => {},
        } as never;
      },
    });

    const first = await execute({
      runId: "run-config-baseline",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "PAP-1",
      },
      config: {
        agent: "codex",
        stateDir,
        modelReasoningEffort: "high",
        fastMode: true,
      },
      context: { paperclipWorkspace: { cwd: root, source: "project_workspace", workspaceId: "workspace-1" } },
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(first.exitCode).toBe(0);

    const second = await execute({
      runId: "run-config-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {
        sessionId: first.sessionId,
        sessionParams: first.sessionParams,
        sessionDisplayId: first.sessionDisplayId,
        taskKey: "PAP-1",
      },
      config: {
        agent: "codex",
        stateDir,
        modelReasoningEffort: "high",
        fastMode: true,
      },
      context: { paperclipWorkspace: { cwd: root, source: "project_workspace", workspaceId: "workspace-1" } },
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(second.exitCode).toBe(0);
    expect(second.errorCode).toBeNull();
    expect(startTurnCalls).toBe(2);
    expect(setConfigInputs).toEqual([
      { key: "reasoning_effort", value: "high" },
      { key: "service_tier", value: "fast" },
      { key: "features.fast_mode", value: "true" },
      { key: "reasoning_effort", value: "high" },
      { key: "service_tier", value: "fast" },
      { key: "features.fast_mode", value: "true" },
    ]);
    expect(logs).toContainEqual({
      stream: "stdout",
      text:
        '[paperclip] ACPX resumed session "runtime-session" does not advertise config reasoning_effort; skipping the override and continuing.\n',
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

  it("keeps fresh credential wrapper scripts across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      agent: "custom-a",
      env: { PAPERCLIP_API_KEY: "old-key" },
    }, { runId: "run-a" });
    await runExecutor({
      ...baseConfig,
      agent: "custom-b",
      env: { PAPERCLIP_API_KEY: "new-key" },
    }, { runId: "run-b" });

    expect(await listWrapperRunDirs(stateDir)).toEqual(["run-a", "run-b"]);
    const runBFiles = await listWrapperFilesForRun(stateDir, "run-b");
    const wrapperPath = path.join(stateDir, "wrappers", "run-b", runBFiles.find((name) => name.startsWith("custom-b-") && name.endsWith(".sh"))!);
    const envPath = path.join(stateDir, "wrappers", "run-b", runBFiles.find((name) => name.startsWith("custom-b-") && name.endsWith(".env"))!);
    const wrapper = await fs.readFile(wrapperPath, "utf8");
    const env = await fs.readFile(envPath, "utf8");
    expect((await fs.stat(envPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(wrapperPath)).mode & 0o777).toBe(0o700);
    expect(wrapper).toContain("node ./fake-acp.js");
    expect(wrapper).not.toContain("PAPERCLIP_API_KEY");
    expect(wrapper).not.toContain("new-key");
    expect(wrapper).not.toContain("old-key");
    expect(env).toContain("PAPERCLIP_API_KEY='new-key'");
    expect(env).not.toContain("old-key");
  });

  it("shapes ACPX wrapper workspace env for remote execution identities", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    await runExecutor(
      {
        agentCommand: "node ./fake-acp.js",
        stateDir,
      },
      {
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
            strategy: "git_worktree",
            workspaceId: "workspace-1",
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
            branchName: "feature/remote-acpx",
            worktreePath: workspaceDir,
          },
        },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
      },
    );

    const wrappers = await listWrapperFilesForRun(stateDir, "run-1");
    const envPath = path.join(
      stateDir,
      "wrappers",
      "run-1",
      wrappers.find((name) => name.endsWith(".env"))!,
    );
    const env = await fs.readFile(envPath, "utf8");

    expect(env).toContain("PAPERCLIP_WORKSPACE_CWD='/remote/workspace'");
    expect(env).not.toContain("PAPERCLIP_WORKSPACE_WORKTREE_PATH=");
  });

  it("cleans aged credential wrapper scripts across ACPX agent changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const wrappersDir = path.join(stateDir, "wrappers");
    const baseConfig = {
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      agent: "custom-a",
      env: { PAPERCLIP_API_KEY: "old-key" },
    }, { runId: "run-a" });
    const oldDate = new Date(Date.now() - 16 * 60 * 1000);
    await Promise.all(
      [path.join(wrappersDir, "run-a")]
        .map(async (dir) => {
          const files = await fs.readdir(dir);
          await Promise.all(files.map((name) => fs.utimes(path.join(dir, name), oldDate, oldDate)));
          await fs.utimes(dir, oldDate, oldDate);
        }),
    );

    await runExecutor({
      ...baseConfig,
      agent: "custom-b",
      env: { PAPERCLIP_API_KEY: "new-key" },
    }, { runId: "run-b" });

    expect(await listWrapperRunDirs(stateDir)).toEqual(["run-b"]);
    const wrappers = await listWrapperFilesForRun(stateDir, "run-b");
    expect(wrappers.filter((name) => name.endsWith(".sh"))).toHaveLength(1);
    expect(wrappers.filter((name) => name.endsWith(".env"))).toHaveLength(1);
    expect(wrappers.some((name) => name.startsWith("custom-b-"))).toBe(true);
  });

  it("keeps distinct wrapper env files for concurrent runs with different credentials", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const baseConfig = {
      agent: "custom-a",
      agentCommand: "node ./fake-acp.js",
      stateDir,
    };

    await runExecutor({
      ...baseConfig,
      env: { PAPERCLIP_API_KEY: "first-key" },
    }, { runId: "run-a" });
    await runExecutor({
      ...baseConfig,
      env: { PAPERCLIP_API_KEY: "second-key" },
    }, { runId: "run-b" });

    const envFileNames = (
      await Promise.all(
        (await listWrapperRunDirs(stateDir)).map(async (runId) =>
          (await listWrapperFilesForRun(stateDir, runId)).map((name) => path.join(runId, name)),
        ),
      )
    )
      .flat()
      .filter((name) => name.endsWith(".env"));
    expect(envFileNames).toHaveLength(2);
    const envFiles = await Promise.all(
      envFileNames.map(async (name) => fs.readFile(path.join(stateDir, "wrappers", name), "utf8")),
    );
    expect(envFiles.filter((contents) => contents.includes("PAPERCLIP_API_KEY='first-key'"))).toHaveLength(1);
    expect(envFiles.filter((contents) => contents.includes("PAPERCLIP_API_KEY='second-key'"))).toHaveLength(1);
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

  it("writes wrapper that redirects child stderr to a per-run log file", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const runtimeOptions: AcpRuntimeOptions[] = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: (options) => {
        runtimeOptions.push(options as unknown as AcpRuntimeOptions);
        return buildRuntime() as never;
      },
    });

    const result = await execute({
      runId: "run-stderr-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    const verboseFlags = runtimeOptions.map((options) => (options as { verbose?: boolean }).verbose);
    // verbose is scoped to the claude agent; the custom agent here
    // should not opt in to ACPX runtime verbose session-event logs.
    expect(verboseFlags.every((flag) => flag === false)).toBe(true);

    const wrappers = await listWrapperFilesForRun(stateDir, "run-stderr-1");
    const wrapperFile = wrappers.find((name) => name.endsWith(".sh"));
    expect(wrapperFile).toBeTruthy();
    const wrapper = await fs.readFile(path.join(stateDir, "wrappers", "run-stderr-1", wrapperFile!), "utf8");
    expect(wrapper).toContain("stderr_dir=");
    expect(wrapper).toContain("run-stderr");
    expect(wrapper).toContain("PAPERCLIP_RUN_ID");
    expect(wrapper).toContain("exec 2>>");
    expect(wrapper).toContain("exec node ./fake-acp.js");
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

  it("writes the preflight-selected Paperclip URL into the ACP wrapper env file", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "worktree");
    await fs.mkdir(cwd, { recursive: true });

    const gatedApiUrl = "https://paperclip.quote-to-invoice.ai";
    const reachableApiUrl = "http://127.0.0.1:3100";
    process.env.PAPERCLIP_API_URL = gatedApiUrl;
    process.env.PAPERCLIP_RUNTIME_API_URL = gatedApiUrl;
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify([gatedApiUrl, reachableApiUrl]);

    vi.spyOn(executionTarget, "preparePaperclipControlPlaneEnvForAdapterRun").mockImplementation(async (input) => {
      input.env.PAPERCLIP_API_URL = reachableApiUrl;
      input.env.PAPERCLIP_RUNTIME_API_URL = reachableApiUrl;
      return {
        ok: true,
        skipped: false,
        changed: true,
        url: reachableApiUrl,
        attempts: [
          {
            url: reachableApiUrl,
            status: 200,
            contentType: "application/json",
          },
        ],
        reasons: [],
      };
    });

    await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir,
      cwd,
    });

    const wrapperEnvFile = (await listWrapperFilesForRun(stateDir, "run-1")).find((name) => name.endsWith(".env"));
    expect(wrapperEnvFile).toBeTruthy();
    const wrapperEnv = await fs.readFile(path.join(stateDir, "wrappers", "run-1", wrapperEnvFile!), "utf8");
    expect(wrapperEnv).toContain(`PAPERCLIP_API_URL='${reachableApiUrl}'`);
    expect(wrapperEnv).toContain(`PAPERCLIP_RUNTIME_API_URL='${reachableApiUrl}'`);
    expect(wrapperEnv).not.toContain(`PAPERCLIP_API_URL='${gatedApiUrl}'`);
  });

  it.skipIf(process.platform === "win32")("captures child stderr in the per-run log without using process substitution", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");

    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
    });

    const fakeAgentPath = path.join(root, "fake-acp.sh");
    await fs.writeFile(
      fakeAgentPath,
      [
        "#!/usr/bin/env bash",
        "echo \"Error handling request { method: 'nes/close' } { code: -32601, message: '\\\"Method not found\\\": nes/close' }\" >&2",
        "echo \"some genuine crash: TypeError: x is not a function\" >&2",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = await execute({
      runId: "run-nes-close-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: fakeAgentPath,
        stateDir,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    const wrapperFile = (await listWrapperFilesForRun(stateDir, "run-nes-close-1")).find((name) => name.endsWith(".sh"));
    expect(wrapperFile).toBeTruthy();
    const wrapperPath = path.join(stateDir, "wrappers", "run-nes-close-1", wrapperFile!);

    const { stderr } = await execFileAsync("bash", [wrapperPath], {
      env: { ...process.env, PAPERCLIP_RUN_ID: "run-nes-close-1" },
    });

    expect(stderr).toBe("");

    const runLog = await fs.readFile(path.join(stateDir, "run-stderr", "run-nes-close-1.log"), "utf8");
    expect(runLog).toContain("nes/close");
    expect(runLog).toContain("some genuine crash: TypeError: x is not a function");
  });

  it("passes Paperclip env through the ACP agent wrapper instead of process.env", async () => {
    let observedApiKeyDuringStream: string | undefined;
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            await Promise.resolve();
            observedApiKeyDuringStream = process.env.PAPERCLIP_API_KEY;
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    const previousRuntimeApiCandidates = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    const previousRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    const previousPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    try {
      delete process.env.PAPERCLIP_API_KEY;
      delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
      delete process.env.PAPERCLIP_RUNTIME_API_URL;
      delete process.env.PAPERCLIP_API_URL;
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
        },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js" },
        context: {},
        authToken: "runtime-key",
        onLog: async () => {},
        onMeta: async () => {},
      } as never);

      expect(result.exitCode).toBe(0);
      expect(observedApiKeyDuringStream).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
      if (previousRuntimeApiCandidates === undefined) delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
      else process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = previousRuntimeApiCandidates;
      if (previousRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
      else process.env.PAPERCLIP_RUNTIME_API_URL = previousRuntimeApiUrl;
      if (previousPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = previousPaperclipApiUrl;
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

  it("skips Codex model transport through ACP session config", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const modelConfigInputs: Array<{ key: string; value: string }> = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        setConfigOption: async (input: { key: string; value: string }) => {
          modelConfigInputs.push({ key: input.key, value: input.value });
        },
        startTurn: () => ({
          events: {
            [Symbol.asyncIterator]: async function* () {
              yield { type: "done", stopReason: "end_turn" };
            },
          },
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const meta: Array<Record<string, unknown>> = [];
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
      },
      runtime: {},
      config: {
        agent: "codex",
        stateDir,
        model: "gpt-5.6-sol",
        modelReasoningEffort: "high",
        fastMode: true,
      },
      context: { paperclipWorkspace: { cwd: root, source: "project_workspace", workspaceId: "workspace-1" } },
      onLog: async () => {},
      onMeta: async (payload: Record<string, unknown>) => {
        meta.push(payload);
      },
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(modelConfigInputs).toEqual([
      { key: "reasoning_effort", value: "high" },
      { key: "service_tier", value: "fast" },
      { key: "features.fast_mode", value: "true" },
    ]);
    const commandNotes = meta[0]?.commandNotes;
    expect(Array.isArray(commandNotes)).toBe(true);
    expect(
      (commandNotes as string[]).some((note) =>
        String(note).includes("Requested ACPX model: gpt-5.6-sol (using Codex lane default model configuration)."),
      ),
    ).toBe(true);
    expect(modelConfigInputs.some(({ key, value }) => key === "model" && value === "gpt-5.6-sol")).toBe(false);
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

  async function writeBrokenClaudeBin(dir: string) {
    const binDir = path.join(dir, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, "claude-agent-acp");
    await fs.writeFile(
      binPath,
      [
        "#!/usr/bin/env bash",
        'basedir=$(dirname "$0")',
        'exec node "$basedir/../@agentclientprotocol/claude-agent-acp/dist/index.js" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
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

  it("prefers the hoisted claude-agent-acp wrapper when both package-local and ancestor bins exist", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    await writeFakeBin(packageDir, "claude-agent-acp");
    const expectedBin = await writeFakeBin(root, "claude-agent-acp");

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

  it("skips a broken package-local claude-agent-acp wrapper and falls back to a healthy ancestor bin", async () => {
    const root = await makeTempRoot();
    const packageDir = path.join(root, "node_modules", "@paperclipai", "adapter-utils");
    await fs.mkdir(packageDir, { recursive: true });
    await writeBrokenClaudeBin(packageDir);
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

  async function readGeminiWrapperScript(stateDir: string): Promise<string> {
    const wrappersDir = path.join(stateDir, "wrappers");
    const runDirs = await fs.readdir(wrappersDir);
    expect(runDirs).toHaveLength(1);
    const names = await fs.readdir(path.join(wrappersDir, runDirs[0]!));
    const scriptName = names.find((name) => name.endsWith(".sh"));
    expect(scriptName).toBeTypeOf("string");
    return fs.readFile(path.join(wrappersDir, runDirs[0]!, scriptName!), "utf8");
  }

  it("isolates wrapper files per run and prunes stale sibling run directories", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const staleRunDir = path.join(stateDir, "wrappers", "stale-run");
    await fs.mkdir(staleRunDir, { recursive: true });
    await fs.writeFile(path.join(staleRunDir, "codex-stale.sh"), "#!/usr/bin/env bash\n", { mode: 0o700 });
    const staleTime = new Date(Date.now() - 16 * 60 * 1000);
    await fs.utimes(staleRunDir, staleTime, staleTime);
    await fs.utimes(path.join(staleRunDir, "codex-stale.sh"), staleTime, staleTime);

    await runExecutor({
      agent: "codex",
      stateDir,
      env: { HOME: path.join(root, "home") },
    });

    const wrappersRoot = path.join(stateDir, "wrappers");
    const runDirs = await fs.readdir(wrappersRoot);
    expect(runDirs).toEqual(["run-1"]);
    const wrapperFiles = await fs.readdir(path.join(wrappersRoot, "run-1"));
    expect(wrapperFiles.some((name) => name.endsWith(".sh"))).toBe(true);
    expect(wrapperFiles.some((name) => name.endsWith(".env"))).toBe(true);
    await expect(fs.access(staleRunDir)).rejects.toThrow();
  });

  it("writes Claude wrappers against the resolved ACP entrypoint instead of the package-local .bin shim", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const realClaudePackageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../adapters/claude-local",
    );
    const execute = createAcpxEngineExecutor({
      packageRootDir: realClaudePackageRoot,
      createRuntime: () => buildRuntime() as never,
    });

    const result = await execute({
      runId: "run-claude-wrapper-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "claude",
        stateDir,
        env: { HOME: path.join(root, "home") },
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    const script = await readGeminiWrapperScript(stateDir);
    expect(
      (script.includes('exec node ') &&
        script.includes('@agentclientprotocol/claude-agent-acp/dist/index.js')) ||
        script.includes('exec claude-agent-acp "$@"'),
    ).toBe(true);
    expect(script).not.toContain('/packages/adapters/claude-local/node_modules/.bin/claude-agent-acp');
  });

  it("writes a gemini wrapper that execs a multi-word command instead of a single quoted token", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.33.0");

    await runExecutor({
      agent: "gemini",
      stateDir,
      env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) },
    });

    const script = await readGeminiWrapperScript(stateDir);
    expect(script).toContain('exec gemini --acp "$@"');
    expect(script).not.toContain("'gemini --acp'");
  });

  it("downgrades the built-in gemini command flag when the local CLI predates --acp", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const binDir = path.join(root, "bin");
    await writeFakeGemini(binDir, "0.30.0");

    await runExecutor({
      agent: "gemini",
      stateDir,
      env: { HOME: path.join(root, "home"), PATH: pathWithFakeBin(binDir) },
    });

    const script = await readGeminiWrapperScript(stateDir);
    expect(script).toContain('exec gemini --experimental-acp "$@"');
  });
});

describe("shared ACP engine execution timeouts", () => {
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

describe("shared ACP engine stream-idle retries", () => {
  it("keeps a healthy turn alive when stream events arrive before the idle threshold", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const progressUpdates: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield { type: "text_delta", text: "tick-1", stream: "output", tag: "agent_message_chunk" };
            await new Promise((resolve) => setTimeout(resolve, 25));
            yield { type: "text_delta", text: "tick-2", stream: "output", tag: "agent_message_chunk" };
            await new Promise((resolve) => setTimeout(resolve, 25));
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-stream-idle-healthy",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        streamIdleTimeoutMs: 40,
        streamIdleMaxRetries: 1,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onRuntimeProgress: async (update: RuntimeStatusUpdate) => {
        progressUpdates.push(update as unknown as Record<string, unknown>);
      },
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(progressUpdates.some((update) => typeof update.lastStreamEventAt === "object")).toBe(true);
  });

  it("retries a turn once after the stream stays silent past the idle threshold", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const logs: Array<{ stream: string; text: string }> = [];
    let startTurnCalls = 0;
    let releaseFirstTurn: (() => void) | null = null;

    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: `backend-session-${startTurnCalls + 1}`,
          agentSessionId: `agent-session-${startTurnCalls + 1}`,
          runtimeSessionName: `runtime-session-${startTurnCalls + 1}`,
        }),
        startTurn: () => {
          startTurnCalls += 1;
          if (startTurnCalls === 1) {
            const cancelled = new Promise<void>((resolve) => {
              releaseFirstTurn = resolve;
            });
            return {
              events: (async function* () {
                yield { type: "text_delta", text: "warmup", stream: "output", tag: "agent_message_chunk" };
                await cancelled;
              })(),
              result: cancelled.then(() => ({ status: "cancelled", stopReason: "cancelled" })),
              cancel: async () => {
                releaseFirstTurn?.();
              },
            };
          }
          return {
            events: (async function* () {
              yield { type: "text_delta", text: "recovered", stream: "output", tag: "agent_message_chunk" };
              yield { type: "done", stopReason: "end_turn" };
            })(),
            result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
            cancel: async () => {},
          };
        },
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-stream-idle-retry",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        streamIdleTimeoutMs: 40,
        streamIdleMaxRetries: 1,
      },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({ streamIdleRetryCount: 1 });
    expect(startTurnCalls).toBe(2);
    expect(logs.some((entry) => entry.text.includes("retrying ACPX turn with a fresh session"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("\"type\":\"acpx.session_retry\""))).toBe(true);
  });

  it("fails after the retry path also stalls past the idle threshold", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let releaseTurn: (() => void) | null = null;
    let startTurnCalls = 0;

    const execute = createAcpxEngineExecutor({
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: `backend-session-${startTurnCalls + 1}`,
          agentSessionId: `agent-session-${startTurnCalls + 1}`,
          runtimeSessionName: `runtime-session-${startTurnCalls + 1}`,
        }),
        startTurn: () => {
          startTurnCalls += 1;
          const cancelled = new Promise<void>((resolve) => {
            releaseTurn = resolve;
          });
          return {
            events: (async function* () {
              yield { type: "text_delta", text: `warmup-${startTurnCalls}`, stream: "output", tag: "agent_message_chunk" };
              await cancelled;
            })(),
            result: cancelled.then(() => ({ status: "cancelled", stopReason: "cancelled" })),
            cancel: async () => {
              releaseTurn?.();
            },
          };
        },
        close: async () => {},
      }) as never,
    });

    const result = await execute({
      runId: "run-stream-idle-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        streamIdleTimeoutMs: 40,
        streamIdleMaxRetries: 1,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_stream_idle_timeout");
    expect(result.clearSession).toBe(true);
    expect(result.resultJson).toMatchObject({
      phase: "turn",
      streamIdleTimeout: {
        timeoutMs: 40,
        retryCount: 1,
      },
    });
    expect(startTurnCalls).toBe(2);
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
    const { sessionInputs, events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    // Crossing the staging seam emits a per-step timing event for the sync.
    const stageEvent = events.find(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "stage.sync",
    );
    expect(stageEvent).toBeTruthy();
    expect(typeof stageEvent!.payload?.durationMs).toBe("number");

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

  it("hands the merged paperclip env to the process-session launch when the setups overlap", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    // Decode the process-session LAUNCH payload (the base64 command blob) — the
    // in-sandbox process env is carried there, NOT in the exec's own `env`.
    let launchPayload: Record<string, unknown> | null = null;
    (executionTarget as { runner: unknown }).runner = createLocalSandboxRunner((input) => {
      if (input.env?.PAPERCLIP_SANDBOX_EXEC_CHANNEL === "bridge") {
        const script = input.args?.[1] ?? "";
        const match = script.match(/PAPERCLIP_PROCESS_SESSION_COMMAND_B64='([^']+)'/);
        if (match) {
          launchPayload = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as Record<
            string,
            unknown
          >;
        }
      }
    });

    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    // The process-session bridge receives its launch env as a DEFERRED thunk —
    // the seam that lets its env-independent setup overlap the paperclip bridge
    // start instead of running strictly after it.
    const processArgs = vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mock.calls[0]![0];
    expect(typeof processArgs.env).toBe("function");

    // ...and despite the overlap the launch still observes the MERGED paperclip
    // env: the paperclip-`env` → process-session-launch hand-off stays sequenced
    // under concurrency (bridge base URL + minted bridge token both present, and
    // the token is NOT the host run JWT).
    const payloadEnv = ((launchPayload as Record<string, unknown> | null)?.env ?? {}) as Record<
      string,
      unknown
    >;
    expect(payloadEnv).toMatchObject({ PAPERCLIP_API_BRIDGE_MODE: "queue_v1" });
    expect(String(payloadEnv.PAPERCLIP_API_URL ?? "")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(payloadEnv.PAPERCLIP_API_KEY).toBeTruthy();
    expect(payloadEnv.PAPERCLIP_API_KEY).not.toBe("real-run-jwt");
  });

  it("stops the process-session bridge when the paperclip bridge fails under concurrency", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    // The paperclip bridge fails; the process-session bridge — started CONCURRENTLY
    // with it — still resolves a live handle. The abandon path must stop that
    // handle so no started bridge leaks on partial failure.
    const stop = vi.fn(async () => {});
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementationOnce(async () => {
      throw new Error("paperclip bridge boom");
    });
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementationOnce(
      async () => ({ agentCommand: null, stop }) as never,
    );

    const execute = createAcpxEngineExecutor({
      createRuntime: () => buildRuntime() as never,
    });

    await expect(
      execute({
        runId: "run-bridge-fail",
        agent: { id: "agent-1", companyId: "company-1" },
        runtime: {},
        config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
        context: {},
        authToken: "real-run-jwt",
        executionTarget,
        onLog: async () => {},
        onMeta: async () => {},
        onEvent: async () => {},
      } as never),
    ).rejects.toThrow("paperclip bridge boom");

    // The concurrently-started process-session bridge was stopped exactly once.
    expect(stop).toHaveBeenCalledTimes(1);
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

describe("ACPX engine remote managed-home seam (PR 2: per-adapter home seed)", () => {
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
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };
    return { root, stateDir, localCwd, remoteCwd, executionTarget };
  }

  it("test_remote_seam_receives_adapter_agnostic_context", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    let captured: Record<string, unknown> | null = null;
    const { sessionInputs, events } = await runExecutor(
      {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        // A user/adapter-config env value proves the seam sees the resolved run env.
        env: { SEAM_MARKER: "seam-marker-value" },
      },
      {
        authToken: "real-run-jwt",
        executionTarget,
        prepareRemoteManagedHome: async (input) => {
          captured = input as unknown as Record<string, unknown>;
          const stagedRuntime = await input.stage([]);
          return { stagedRuntime };
        },
      },
    );

    // The managed-home seam runs inside the timed stage.sync boundary, so a
    // per-step timing event is emitted for it.
    const stageEvent = events.find(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "stage.sync",
    );
    expect(stageEvent).toBeTruthy();
    expect(typeof stageEvent!.payload?.durationMs).toBe("number");

    // The engine invoked the seam and used the runtime it staged (session/new
    // binds to the in-sandbox workspace dir the seam returned).
    expect(captured).not.toBeNull();
    const context = captured as unknown as Record<string, unknown>;
    // Only generic, adapter-agnostic inputs cross the boundary...
    expect(context.acpxAgent).toBe("custom");
    expect(context.companyId).toBe("company-1");
    expect(context.runId).toBe("run-1");
    expect(context.workspaceLocalDir).toBe(localCwd);
    expect(context.executionTarget).toMatchObject({ kind: "remote", transport: "sandbox" });
    expect(typeof context.stage).toBe("function");
    expect(typeof context.timeoutSec).toBe("number");
    // ...including the resolved run env (adapter config env folded in).
    expect((context.env as Record<string, string>).SEAM_MARKER).toBe("seam-marker-value");
    // ...and NOTHING scoped to a single adapter leaks across the seam. This locks
    // the boundary: the engine must not hand a Gemini/Claude/Codex-specific field
    // (e.g. the former `geminiSkillsHome`) to the generic seam context.
    expect(context).not.toHaveProperty("geminiSkillsHome");
    expect(Object.keys(context).some((key) => /gemini|claude|codex/i.test(key))).toBe(false);
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
  });

  it("test_remote_seam_stages_assets_and_env_remap_reaches_process", async () => {
    const { root, stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    // A managed-home dir the seam ships as an asset (mirrors a per-adapter home).
    const managedHomeDir = path.join(root, "managed-home");
    await fs.mkdir(managedHomeDir, { recursive: true });
    await fs.writeFile(path.join(managedHomeDir, "config.json"), "{}", "utf8");

    const { meta } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      {
        authToken: "real-run-jwt",
        executionTarget,
        prepareRemoteManagedHome: async (input) => {
          const stagedRuntime = await input.stage([
            { key: "home", localDir: managedHomeDir, followSymlinks: true },
          ]);
          // Repoint an adapter home env var onto the in-sandbox asset dir; the
          // engine must forward this mutated run env to the spawned process.
          input.env.MANAGED_HOME = stagedRuntime.assetDirs.home ?? "";
          return { stagedRuntime };
        },
      },
    );

    // The seam's asset was threaded through the shared staging seam...
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    expect(stageArgs.assets).toEqual([
      { key: "home", localDir: managedHomeDir, followSymlinks: true },
    ]);
    // ...it really landed in the sandbox (local runner extracts to the asset dir)...
    const remoteAssetDir = String((meta[0]?.env as Record<string, string>).MANAGED_HOME);
    expect(remoteAssetDir).toBeTruthy();
    await expect(fs.readFile(path.join(remoteAssetDir, "config.json"), "utf8")).resolves.toBe("{}");
    // ...the staged asset dir resolves under the run's managed runtime root (an
    // in-sandbox path), not the host managed-home dir.
    expect(remoteAssetDir).toContain(".paperclip-runtime");
    expect(remoteAssetDir).not.toBe(managedHomeDir);
    expect(path.isAbsolute(remoteAssetDir)).toBe(true);
  });

  it("test_remote_seam_teardown_fires_once_on_exit", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    let teardownCalls = 0;
    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      {
        authToken: "real-run-jwt",
        executionTarget,
        prepareRemoteManagedHome: async (input) => {
          const stagedRuntime = await input.stage([]);
          return {
            stagedRuntime,
            teardown: async () => {
              teardownCalls += 1;
            },
          };
        },
      },
    );

    // The engine fires the seam's teardown exactly once on the exit/cleanup path
    // (mirrors the codex auth copy-back + staged-temp cleanup finally).
    expect(teardownCalls).toBe(1);
  });

  it("test_remote_seam_absent_stages_workspace_only", async () => {
    // Without a seam (custom agents / adapters with no home seed), the remote lane
    // stages the workspace with no home asset — byte-identical to PR-1 behavior.
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const { sessionInputs } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(1);
    const stageArgs = vi.mocked(prepareAdapterExecutionTargetRuntime).mock.calls[0]![0];
    expect(stageArgs.assets ?? []).toEqual([]);
    expect(sessionInputs[0]?.cwd).toBe(remoteCwd);
  });
});

describe("ACPX engine remote session-lifecycle re-staging (PR 3: stage once / reuse on compatible resume)", () => {
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
    await fs.writeFile(path.join(localCwd, "hello.txt"), "hi", "utf8");
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };
    return { root, stateDir, localCwd, remoteCwd, executionTarget };
  }

  // A runtime double that records ensureSession inputs and can be told to make
  // the turn fail (to exercise the teardown/eviction path).
  function recordingRuntime(input: {
    ensureInputs: Array<Record<string, unknown>>;
    terminalStatus?: "completed" | "failed";
  }) {
    return {
      ensureSession: async (session: Record<string, unknown>) => {
        input.ensureInputs.push(session);
        return {
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        };
      },
      startTurn: () => ({
        events: (async function* () {
          yield { type: "done", stopReason: "end_turn" };
        })(),
        result:
          input.terminalStatus === "failed"
            ? Promise.resolve({ status: "failed", error: new Error("boom") })
            : Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        cancel: async () => {},
      }),
      setConfigOption: async () => {},
      close: async () => {},
    };
  }

  function baseExecuteArgs(input: {
    stateDir: string;
    localCwd: string;
    executionTarget: Record<string, unknown>;
    env?: Record<string, string>;
  }) {
    return {
      agent: { id: "agent-1", companyId: "company-1" },
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir: input.stateDir,
        cwd: input.localCwd,
        mode: "persistent",
        warmHandleIdleMs: 60_000,
        ...(input.env ? { env: input.env } : {}),
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget: input.executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
    };
  }

  it("test_acp_resume_compatible_session_does_not_restage", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Staging (workspace ship + home seed) ran exactly ONCE across both runs:
    // the compatible resume reused the already-staged in-sandbox runtime.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(1);
    // Both runs bind session/new (and resume) to the in-sandbox workspace cwd...
    expect(ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    // ...and the second run RESUMES the first session rather than starting fresh.
    expect(ensureInputs[1]?.resumeSessionId).toBe(first.sessionId);
  });

  it("test_acp_resume_incompatible_fingerprint_stages_fresh", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
    });

    const first = await execute({
      runId: "run-a",
      runtime: {},
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { FOO: "a" } }),
    } as never);
    // A changed adapter env value shifts the session fingerprint → a different
    // sessionKey → the cache slot does not match, so staging runs fresh.
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { FOO: "b" } }),
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Incompatible fingerprint → staged fresh, no stale reuse.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    expect(ensureInputs[0]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    // The second run does NOT resume the first session (fingerprint differs).
    expect(ensureInputs[1]?.resumeSessionId).toBeUndefined();
  });

  it("test_warm_handle_scoped_per_fingerprint_no_cross_session_credential_reuse", async () => {
    const { root, stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    // Two managed homes, one per session, each carrying a distinct credential
    // marker. The seam seeds whichever home belongs to the current run.
    const homeA = path.join(root, "home-a");
    const homeB = path.join(root, "home-b");
    await fs.mkdir(homeA, { recursive: true });
    await fs.mkdir(homeB, { recursive: true });
    await fs.writeFile(path.join(homeA, "auth.json"), JSON.stringify({ token: "SECRET-A" }), "utf8");
    await fs.writeFile(path.join(homeB, "auth.json"), JSON.stringify({ token: "SECRET-B" }), "utf8");

    const seededHomeEnv: string[] = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        const localHome = input.env.SESSION_MARKER === "b" ? homeB : homeA;
        const stagedRuntime = await input.stage([
          { key: "home", localDir: localHome, followSymlinks: true },
        ]);
        input.env.MANAGED_HOME = stagedRuntime.assetDirs.home ?? "";
        seededHomeEnv.push(input.env.MANAGED_HOME);
        return { stagedRuntime };
      },
    });

    const first = await execute({
      runId: "run-a",
      runtime: {},
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { SESSION_MARKER: "a" } }),
    } as never);
    // Different fingerprint (SESSION_MARKER changed) → different sessionKey. If the
    // cache were NOT fingerprint-scoped, this run could silently inherit session A's
    // staged auth.json without re-seeding. It must instead seed its own home.
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...baseExecuteArgs({ stateDir, localCwd, executionTarget, env: { SESSION_MARKER: "b" } }),
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Each session staged its OWN managed home — no cross-session reuse.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    expect(seededHomeEnv).toHaveLength(2);
    // Session B's staged home holds session B's credential, never session A's.
    const bHome = seededHomeEnv[1]!;
    await expect(fs.readFile(path.join(bHome, "auth.json"), "utf8")).resolves.toContain("SECRET-B");
  });

  it("test_acp_failed_turn_evicts_staged_runtime_so_resume_restages", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      // The first turn fails; the second (compatible) run then completes.
      createRuntime: (() => {
        let call = 0;
        return () => {
          call += 1;
          return recordingRuntime({
            ensureInputs,
            terminalStatus: call === 1 ? "failed" : "completed",
          }) as never;
        };
      })(),
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(1);
    expect(second.exitCode).toBe(0);
    // A failed turn discards the staged runtime, so the next run stages fresh
    // instead of reusing a torn-down session's staged credentials.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
  });

  // Greptile P1 "Cache Reuse Bypasses Session Compatibility": a fresh invocation
  // that shares company/agent/task/fingerprint (hence sessionKey) with a prior
  // run but carries NO sessionParams starts a new ACP session — it must NOT
  // inherit the prior session's staged workspace + managed home.
  it("test_acp_reuse_requires_compatible_resume_not_just_session_key", async () => {
    const { stateDir, localCwd, remoteCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    let seamCalls = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        seamCalls += 1;
        return { stagedRuntime: await input.stage([]) };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    // Same config (identical sessionKey) but sessionParams cleared → this is a
    // NEW session, not a resume of A. The old code reused A's staged runtime on a
    // bare sessionKey hit; the compatibility gate now forces a fresh stage.
    const second = await execute({ runId: "run-b", runtime: {}, ...base } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Staged (and re-seeded the managed home) fresh for the new session — no
    // silent inheritance of the prior session's staged credentials.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    expect(seamCalls).toBe(2);
    // B binds a fresh session/new (no resumeSessionId), it does not resume A.
    expect(ensureInputs[1]?.cwd).toBe(remoteCwd);
    expect(ensureInputs[1]?.resumeSessionId).toBeUndefined();
  });

  // Greptile P1 "Teardown Invalidates Cached Runtime": the per-run copy-back must
  // fire on every run (incl. a reused resume) while the one-time host staged-temp
  // cleanup must NOT fire between clean runs — otherwise the reused staged runtime
  // would be invalidated before the next resume.
  it("test_reused_resume_copies_back_per_run_without_disposing_staged_temp", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    let teardownCalls = 0;
    let disposeCalls = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        const stagedRuntime = await input.stage([]);
        return {
          stagedRuntime,
          teardown: async () => {
            teardownCalls += 1;
          },
          disposeStaged: async () => {
            disposeCalls += 1;
          },
        };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    const second = await execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    // Staged once, reused on the compatible resume.
    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(1);
    // Per-run copy-back fired on BOTH runs — cadence unchanged.
    expect(teardownCalls).toBe(2);
    // The staged temp was never disposed while the entry stayed warm for reuse,
    // so the resume found its staged home intact.
    expect(disposeCalls).toBe(0);
    expect(ensureInputs[1]?.resumeSessionId).toBe(first.sessionId);
  });

  // The one-time dispose DOES fire when the staged runtime is actually dropped
  // (here: a failed turn), releasing the host staged-temp — the copy-back also
  // still fires on the failure path.
  it("test_dropped_staged_runtime_disposes_host_temp", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    let teardownCalls = 0;
    let disposeCalls = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs, terminalStatus: "failed" }) as never,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        teardown: async () => {
          teardownCalls += 1;
        },
        disposeStaged: async () => {
          disposeCalls += 1;
        },
      }),
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const result = await execute({ runId: "run-a", runtime: {}, ...base } as never);

    expect(result.exitCode).toBe(1);
    // Failed turn → staged runtime dropped → host staged-temp disposed once, and
    // the per-run copy-back still fired.
    expect(teardownCalls).toBe(1);
    expect(disposeCalls).toBe(1);
  });

  it("test_idle_staged_runtime_cleanup_waits_for_active_turn_release", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const events: string[] = [];
    let currentNow = 0;
    let releaseTurn!: () => void;
    let signalTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStarted = resolve;
    });
    const turnCompleted = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const execute = createAcpxEngineExecutor({
      now: () => currentNow,
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: (() => {
        let call = 0;
        return () => {
          call += 1;
          return {
            ensureSession: async () => ({
              backendSessionId: "backend-session",
              agentSessionId: "agent-session",
              runtimeSessionName: "runtime-session",
            }),
            startTurn: () => {
              if (call === 2) signalTurnStarted();
              return {
                events: (async function* () {
                  yield { type: "done", stopReason: "end_turn" };
                })(),
                result:
                  call === 2
                    ? turnCompleted.then(() => ({ status: "completed", stopReason: "end_turn" }))
                    : Promise.resolve({ status: "completed", stopReason: "end_turn" }),
                cancel: async () => {},
              };
            },
            setConfigOption: async () => {},
            close: async () => {},
          } as never;
        };
      })(),
      prepareRemoteManagedHome: async (input) => {
        events.push(`stage:${input.runId}`);
        return {
          stagedRuntime: await input.stage([]),
          disposeStaged: async () => {
            events.push(`dispose:${input.runId}`);
          },
        };
      },
    });
    const base = baseExecuteArgs({
      stateDir,
      localCwd,
      executionTarget,
      env: { SESSION_MARKER: "idle-eviction" },
    });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    expect(first.exitCode).toBe(0);

    const second = execute({
      runId: "run-b",
      runtime: { sessionParams: first.sessionParams },
      ...base,
    } as never);
    await turnStarted;
    currentNow = 10_000;
    const third = execute({ runId: "run-c", runtime: {}, ...base } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual(["stage:run-a"]);

    releaseTurn();
    const [resultB, resultC] = await Promise.all([second, third]);

    expect(resultB.exitCode).toBe(0);
    expect(resultC.exitCode).toBe(0);
    expect(events).toEqual(["stage:run-a", "dispose:run-a", "stage:run-c"]);
  });

  // Superseding an incompatible session that collides on sessionKey re-stages
  // fresh AND releases the superseded entry's host staged-temp (no leak, no
  // reuse of the old session's staged credentials).
  it("test_incompatible_restage_disposes_superseded_staged_temp", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const disposedRunIds: string[] = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        disposeStaged: async () => {
          disposedRunIds.push(input.runId);
        },
      }),
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    // Run A completes cleanly and caches its staged runtime.
    await execute({ runId: "run-a", runtime: {}, ...base } as never);
    // Run B: same sessionKey, no sessionParams → not a compatible resume. It must
    // drop + dispose A's superseded staged entry, then stage fresh.
    await execute({ runId: "run-b", runtime: {}, ...base } as never);

    expect(vi.mocked(prepareAdapterExecutionTargetRuntime)).toHaveBeenCalledTimes(2);
    // A's staged temp was disposed when B superseded it.
    expect(disposedRunIds).toContain("run-a");
  });

  // Greptile P1 "Concurrent Runs Corrupt Cache Ownership": two overlapping runs
  // of the same session key must not ship into the same remote workspace at once.
  // The per-key staging lock serializes the stage-or-reuse section, so their
  // staging windows never overlap.
  it("test_concurrent_same_session_staging_is_serialized", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => {
        events.push(`enter:${input.runId}`);
        // Yield to the event loop so an unserialized second run would interleave
        // its own enter here before we finish staging.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const stagedRuntime = await input.stage([]);
        events.push(`exit:${input.runId}`);
        return { stagedRuntime };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    // Both runs share the sessionKey (identical config) and start concurrently.
    const [a, b] = await Promise.all([
      execute({ runId: "run-a", runtime: {}, ...base } as never),
      execute({ runId: "run-b", runtime: {}, ...base } as never),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // Each staging window is a matched enter/exit pair with no interleaving — the
    // lock serialized them (never enter,enter,...,exit,exit).
    expect(events).toHaveLength(4);
    expect(events[0]).toMatch(/^enter:/);
    expect(events[1]).toBe(`exit:${events[0]!.slice("enter:".length)}`);
    expect(events[2]).toMatch(/^enter:/);
    expect(events[3]).toBe(`exit:${events[2]!.slice("enter:".length)}`);
  });

  // Greptile P1 "Lock Ends Before Use": a same-session re-stage must wait for
  // the prior run's active turn and cleanup to finish before it can touch the
  // staged remote workspace again.
  it("test_concurrent_same_session_staging_waits_for_active_turn_cleanup", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const events: string[] = [];
    let releaseTurn!: () => void;
    let signalTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      signalTurnStarted = resolve;
    });
    const turnCompleted = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => {
          signalTurnStarted();
          return {
            events: (async function* () {
              yield { type: "done", stopReason: "end_turn" };
            })(),
            result: turnCompleted.then(() => ({ status: "completed", stopReason: "end_turn" })),
            cancel: async () => {},
          };
        },
        setConfigOption: async () => {},
        close: async () => {},
      }) as never,
      prepareRemoteManagedHome: async (input) => {
        events.push(`enter:${input.runId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const stagedRuntime = await input.stage([]);
        events.push(`exit:${input.runId}`);
        return { stagedRuntime };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const runA = execute({ runId: "run-a", runtime: {}, ...base } as never);
    await turnStarted;
    const runB = execute({ runId: "run-b", runtime: {}, ...base } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).not.toContain("enter:run-b");

    releaseTurn();
    await runA;
    events.push("run-a-finished");
    await runB;

    expect(events).toContain("enter:run-b");
    expect(events.indexOf("enter:run-b")).toBeGreaterThan(events.indexOf("run-a-finished"));
  });

  // The per-session lease must be released when a run is abandoned before it
  // reaches the executor's cleanup (e.g. staging or a bridge fails to start),
  // otherwise the next run of the same session waits on the lease forever. Here
  // the first run's staging throws; the second run of the same session must
  // still acquire the lease and stage instead of deadlocking.
  it("test_failed_staging_releases_lease_so_next_same_session_run_proceeds", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const events: string[] = [];
    let failNextStaging = true;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "backend-session",
          agentSessionId: "agent-session",
          runtimeSessionName: "runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield { type: "done", stopReason: "end_turn" };
          })(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        setConfigOption: async () => {},
        close: async () => {},
      }) as never,
      prepareRemoteManagedHome: async (input) => {
        events.push(`enter:${input.runId}`);
        if (failNextStaging) {
          failNextStaging = false;
          throw new Error("staging boom");
        }
        const stagedRuntime = await input.stage([]);
        events.push(`exit:${input.runId}`);
        return { stagedRuntime };
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    await expect(execute({ runId: "run-a", runtime: {}, ...base } as never)).rejects.toThrow(
      "staging boom",
    );
    // If the failed run had stranded its lease, this second same-session run
    // would hang on it and the test would time out.
    const resultB = await execute({ runId: "run-b", runtime: {}, ...base } as never);

    expect(resultB.exitCode).toBe(0);
    expect(events).toContain("enter:run-b");
    expect(events).toContain("exit:run-b");
  });
});

describe("ACPX engine sandbox-start spans (opt-in root + child parenting)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function remoteSandboxTarget(root: string) {
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(remoteCwd, { recursive: true });
    return {
      kind: "remote",
      transport: "sandbox",
      // A plugin-backed key (not a built-in family). It must never ride a span
      // as a raw attribute.
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };
  }

  it("emits one root span with a child span per bring-up boundary, each parented to the root", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    await runExecutor(
      {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      { authToken: "real-run-jwt", executionTarget, startupTraceContext: traceContext },
    );

    // Exactly one root span, and it is the bring-up root.
    const roots = spans.filter((span) => span.parent === null);
    expect(roots).toHaveLength(1);
    const rootSpan = roots[0]!;
    expect(rootSpan.name).toBe("sandbox.startup");
    expect(rootSpan.ended).toBe(true);

    // A codex bring-up over the remote sandbox lane crosses all 7 boundaries.
    const childNames = spans.filter((span) => span !== rootSpan).map((span) => span.name).sort();
    expect(childNames).toEqual(
      [
        "acp.handshake",
        "bridge.paperclip",
        "bridge.process-session",
        "codex-home.seed",
        "skills.reconcile",
        "stage.sync",
        "workspace.resolve",
      ],
    );

    // Every child parents to the one root and ends.
    for (const span of spans) {
      if (span === rootSpan) continue;
      expect(span.parent, `span "${span.name}" must parent to the root`).toBe(rootSpan);
      expect(span.ended, `span "${span.name}" must end`).toBe(true);
    }
  });

  it("parents both concurrent bridge spans to the root (neither orphans)", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget, startupTraceContext: traceContext },
    );

    const rootSpan = spans.find((span) => span.name === "sandbox.startup" && span.parent === null);
    expect(rootSpan).toBeTruthy();
    const paperclip = spans.find((span) => span.name === "bridge.paperclip");
    const processSession = spans.find((span) => span.name === "bridge.process-session");
    expect(paperclip?.parent).toBe(rootSpan);
    expect(processSession?.parent).toBe(rootSpan);
  });

  it("keeps every span attribute inside the closed allowlist (no command/path/id keys)", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget, startupTraceContext: traceContext },
    );

    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(
          ALLOWED_STARTUP_SPAN_ATTRIBUTE_KEYS.has(key),
          `span "${span.name}" set a non-allowlisted attribute "${key}"`,
        ).toBe(true);
        // No non-finite numeric attribute (no NaN, no Infinity).
        if (typeof value === "number") {
          expect(Number.isFinite(value), `attribute "${key}" must be finite`).toBe(true);
        }
      }
    }
  });

  it("closes the root span with error status when the bring-up handshake fails", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          ensureSession: async () => {
            throw new Error("handshake boom");
          },
          startTurn: () => ({
            events: (async function* () {})(),
            result: Promise.resolve({ status: "failed" }),
            cancel: async () => {},
          }),
          setConfigOption: async () => {},
          close: async () => {},
        }) as never,
    });

    const result = await execute({
      runId: "run-handshake-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      startupTraceContext: traceContext,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    const rootSpan = spans.find((span) => span.name === "sandbox.startup" && span.parent === null);
    expect(rootSpan).toBeTruthy();
    expect(rootSpan!.ended).toBe(true);
    // `2` is `SpanStatusCode.ERROR`.
    expect(rootSpan!.status?.code).toBe(2);
  });

  it("opens no span and does not throw when no trace context is injected", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);

    // runExecutor asserts exitCode 0 internally; the run must complete with no
    // injected trace context (the default no-op path).
    const { result } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );
    expect(result.exitCode).toBe(0);
  });

  it("opens no span for a local run, even when a trace context is injected", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const { traceContext, spans } = createRecordingStartupTrace();

    // A local run has no execution target. The `sandbox.startup` span names a
    // sandbox bring-up, so a local run must stay out of sandbox telemetry.
    const { result } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", startupTraceContext: traceContext },
    );
    expect(result.exitCode).toBe(0);
    expect(spans).toHaveLength(0);
  });

  it("opens no span for an SSH run, even when a trace context is injected", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    const { traceContext, spans } = createRecordingStartupTrace();

    // An SSH run is remote but is not a sandbox, so it also stays out of sandbox
    // telemetry.
    const { result } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      {
        authToken: "real-run-jwt",
        executionTarget: { kind: "remote", transport: "ssh", remoteCwd },
        startupTraceContext: traceContext,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(spans).toHaveLength(0);
  });
});

describe("ACPX engine per-step startup timing (run.startup.step events)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stepEvents(events: Array<{ eventType: string; payload?: Record<string, unknown> }>) {
    return events.filter((event) => event.eventType === "run.startup.step");
  }

  it("emits a run.startup.step event for each of the 7 bring-up boundaries with numeric durationMs", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    // A configured CODEX_HOME keeps the codex-home seed deterministic (skips the
    // managed-home copy from the host ~/.codex) so steps 2 and 3 run cleanly.
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      { authToken: "real-run-jwt", executionTarget },
    );

    const steps = stepEvents(events);
    const seen = new Map(steps.map((event) => [String(event.payload?.step), event]));
    // A codex bring-up over the remote sandbox lane crosses all 7 boundaries.
    for (const step of [
      "workspace.resolve",
      "codex-home.seed",
      "skills.reconcile",
      "stage.sync",
      "bridge.paperclip",
      "bridge.process-session",
      "acp.handshake",
    ]) {
      const event = seen.get(step);
      expect(event, `expected a run.startup.step event for "${step}"`).toBeTruthy();
      expect(typeof event!.payload?.durationMs).toBe("number");
      expect(event!.payload?.durationMs as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits the 5 non-codex boundaries for a custom-agent sandbox bring-up (no codex steps)", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    const emitted = new Set(stepEvents(events).map((event) => String(event.payload?.step)));
    // The custom-agent lane skips the codex-only skill prep entirely...
    expect(emitted.has("codex-home.seed")).toBe(false);
    expect(emitted.has("skills.reconcile")).toBe(false);
    // ...but still times the shared workspace/stage/bridge/handshake boundaries.
    for (const step of [
      "workspace.resolve",
      "stage.sync",
      "bridge.paperclip",
      "bridge.process-session",
      "acp.handshake",
    ]) {
      expect(emitted.has(step), `expected a run.startup.step event for "${step}"`).toBe(true);
    }
  });

  it("carries roundTrips + provider durations for sequential startup steps and keeps concurrent bridge steps duration-only", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    const steps = stepEvents(events);
    const seen = new Map(steps.map((event) => [String(event.payload?.step), event]));

    // Every timed boundary still records duration.
    for (const event of steps) {
      expect(typeof event.payload?.durationMs).toBe("number");
    }
    // Sequential boundaries retain runner-counter attribution.
    for (const step of ["workspace.resolve", "stage.sync", "acp.handshake"]) {
      expect(typeof seen.get(step)?.payload?.roundTrips).toBe("number");
    }
    // workspace.resolve is host-only → zero host→sandbox execs.
    expect(seen.get("workspace.resolve")?.payload?.roundTrips).toBe(0);
    // stage.sync ships the workspace over the exec seam → at least one round-trip,
    // and the accumulated provider durations scale with it.
    const stageSync = seen.get("stage.sync");
    expect(stageSync?.payload?.roundTrips as number).toBeGreaterThan(0);
    expect(stageSync?.payload?.providerExecMs).toBe(
      (stageSync?.payload?.roundTrips as number) * 600,
    );
    expect(stageSync?.payload?.providerGetMs).toBe(
      (stageSync?.payload?.roundTrips as number) * 15,
    );
    // Concurrent bridge steps are duration-only so they do not double-count
    // shared runner counters while their lifecycles overlap.
    for (const step of ["bridge.paperclip", "bridge.process-session"]) {
      expect(seen.get(step)?.payload?.roundTrips).toBeUndefined();
      expect(seen.get(step)?.payload?.providerExecMs).toBeUndefined();
      expect(seen.get(step)?.payload?.providerGetMs).toBeUndefined();
    }
    // The external ACP client crosses no host exec seam.
    expect(seen.get("acp.handshake")?.payload?.roundTrips).toBe(0);
  });

  it("splits acp.handshake into createRuntimeMs and ensureSessionMs sub-phases", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };

    const { events } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget },
    );

    const handshake = stepEvents(events).find((event) => event.payload?.step === "acp.handshake");
    expect(handshake).toBeTruthy();
    expect(typeof handshake!.payload?.createRuntimeMs).toBe("number");
    expect(handshake!.payload?.createRuntimeMs as number).toBeGreaterThanOrEqual(0);
    expect(typeof handshake!.payload?.ensureSessionMs).toBe("number");
    expect(handshake!.payload?.ensureSessionMs as number).toBeGreaterThanOrEqual(0);
  });

  it("emits no acp.handshake event when a warm-handle hit skips the handshake", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const warmHandles = new Map();
    const secondEvents: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: () => buildRuntime() as never,
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
      onEvent: async () => {},
    } as never);
    // The second run reuses the warm handle, so the whole handshake block is
    // skipped — it must emit NO acp.handshake event (not a zero-duration one).
    await execute({
      runId: "run-warm-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: (first as { sessionParams?: unknown }).sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        secondEvents.push(event);
      },
    } as never);

    const handshakeEmitted = secondEvents.some(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "acp.handshake",
    );
    expect(handshakeEmitted).toBe(false);
  });

  it("does not emit startup-step events on a local (non-sandbox) run except workspace.resolve", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });

    const { events } = await runExecutor({
      agent: "custom",
      agentCommand: "node ./fake-acp.js",
      stateDir: path.join(root, "state"),
      cwd: localCwd,
    });

    const emitted = new Set(stepEvents(events).map((event) => String(event.payload?.step)));
    // A local run never crosses the staging seam or starts a bridge, so only the
    // always-run workspace resolution and the ACP handshake are timed.
    expect(emitted.has("workspace.resolve")).toBe(true);
    expect(emitted.has("acp.handshake")).toBe(true);
    expect(emitted.has("stage.sync")).toBe(false);
    expect(emitted.has("bridge.paperclip")).toBe(false);
    expect(emitted.has("bridge.process-session")).toBe(false);
  });
});

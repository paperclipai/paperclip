import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeOptions } from "acpx/runtime";
import type { AdapterExecutionContext, AdapterRuntimeMcpAccess } from "@paperclipai/adapter-utils";
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
  buildAcpxRunSummary,
  createAcpxEngineExecutor,
  findAncestorBin,
  geminiVersionSupportsNativeAcpFlag,
  parseGeminiVersionParts,
  rewriteGeminiAcpFlagForVersion,
  summarizeAcpxTurnUsage,
  type AcpxEngineExecutorOptions,
} from "./execute.js";
import { runChildProcess } from "../server-utils.js";
import {
  getActiveStepContext,
  runWithRuntimeParent,
  SANDBOX_STARTUP_SPAN_ATTRS,
} from "./startup-timing.js";


const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-skills-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  // A remote run stages a process-session bridge whose detached event writer can
  // still be flushing a trailing event file into `.../process-sessions/<id>/events`
  // when the run's own best-effort `client.remove(sessionDir)` (which production
  // catch-wraps) has already returned. Under CI load that trailing write can land
  // between this recursive delete's directory snapshot and its `rmdir`, surfacing as
  // `ENOTEMPTY`. `maxRetries`/`retryDelay` make the cleanup ride out that window the
  // same way production tolerates it, instead of failing the just-passed test.
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
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
    prepareRemoteManagedHome?: AcpxEngineExecutorOptions["prepareRemoteManagedHome"];
    startupTraceContext?: AdapterExecutionContext["startupTraceContext"];
  } = {},
) {
  const runtimeOptions: Record<string, unknown>[] = [];
  const configOptions: Array<{ key: string; value: string }> = [];
  const sessionInputs: Record<string, unknown>[] = [];
  const meta: Record<string, unknown>[] = [];
  const logs: Array<{ stream: string; text: string }> = [];
  const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
  const execute = createAcpxEngineExecutor({
    ...(options.prepareRemoteManagedHome
      ? { prepareRemoteManagedHome: options.prepareRemoteManagedHome }
      : {}),
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

// A recording span, used only in tests. It captures the span name, the parent
// span (resolved from the explicit parent-context token), the attribute map,
// the terminal status, and whether the span ended. The engine treats it purely
// through the structural `StartupSpan` contract.
interface RecordingSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  parent: RecordingSpan | null;
  // The raw third `startSpan` argument — the parent-context token — before the
  // recorder resolves it to a parent span. A root span receives `undefined`
  // here, so a test asserts the trace-root shape from the argument itself.
  parentContextArg: unknown;
  status: { code: number } | null;
  ended: boolean;
  // The count of `end` calls. A guarded `end` closure ends the span at most
  // once, so a test asserts this count equals one for the run root span.
  endCalls: number;
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
          parentContextArg: context,
          status: null,
          ended: false,
          endCalls: 0,
          setAttribute(key: string, value: string | number | boolean) {
            span.attributes[key] = value;
          },
          setStatus(status: { code: number }) {
            span.status = { code: status.code };
          },
          end() {
            span.ended = true;
            span.endCalls += 1;
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

// Mirror the production host-to-sandbox exec seam for one execution. The real
// seam reads the runtime-parent store with `getActiveStepContext()` and opens a
// `sandbox.exec` span whose third `startSpan` argument is the stored
// parent-context token. This test copy issues that same span through the
// injected recorder, so a test asserts which context a startup-body exec parents
// to at the point the run issues it. The recorder pushes the span into `spans`.
function issueSandboxExecFromStore(
  tracing: NonNullable<AdapterExecutionContext["startupTraceContext"]>,
): void {
  const activeStep = getActiveStepContext();
  tracing.tracer.startSpan("sandbox.exec", undefined, activeStep?.parentContext);
}

// The closed span-attribute allowlist for a sandbox-start span. A test asserts
// every recorded attribute key is in this set, so a command, path, id, or
// error-text key can never ride a span. Every key uses the closed
// `paperclip.sandbox.startup.` prefix from the attribute contract.
const A = SANDBOX_STARTUP_SPAN_ATTRS;
const ALLOWED_STARTUP_SPAN_ATTRIBUTE_KEYS = new Set<string>([
  // Step-span keys.
  A.provider,
  A.stepWallMs,
  A.outcome,
  // Root-span keys.
  A.rootWallMs,
  A.rootWorkMs,
  A.rootDiffMs,
  A.coldStart,
  A.region,
  A.imageId,
  A.sandboxId,
  A.leaseId,
  // Handshake sub-times and the parallel-batch tag.
  A.handshakeCreateRuntimeWallMs,
  A.handshakeEnsureSessionWallMs,
  A.batch,
]);

// The closed attribute allowlist for the run root span. It carries only a
// non-reversible run-id hash and its own wall time, so no command, path, id, or
// error text can ride the `task.run` span.
const ALLOWED_RUN_SPAN_ATTRIBUTE_KEYS = new Set<string>([
  "paperclip.task.run.run_id",
  "paperclip.task.run.wall_ms",
]);

// The closed attribute allowlist for the agent turn span. It carries only its
// own wall time, so no command, path, id, prompt, or error text can ride the
// `agent.turn` span.
const ALLOWED_TURN_SPAN_ATTRIBUTE_KEYS = new Set<string>([
  "paperclip.agent.turn.wall_ms",
]);

describe("shared ACPX engine runtime behavior", () => {
  it("persists ACP agent process identity before prompting on each run (host lane re-creates, no warm reuse)", async () => {
    const root = await makeTempRoot();
    const startedAt = "2026-07-30T07:00:00.000Z";
    const processPid = 43_210;
    let runtimeCreateCount = 0;
    let processIdentityPersisted = false;
    let turnStartedBeforeProcessIdentity = false;
    const warmHandles = new Map();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: (options) => {
        runtimeCreateCount += 1;
        const patchedOptions = options as AcpRuntimeOptions & {
          onAgentSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
        };
        return {
          ensureSession: async () => {
            await patchedOptions.onAgentSpawn?.({ pid: processPid, startedAt });
            return {
              backendSessionId: "backend-session",
              agentSessionId: "agent-session",
              runtimeSessionName: "runtime-session",
            };
          },
          startTurn: () => {
            turnStartedBeforeProcessIdentity = !processIdentityPersisted;
            return {
              events: (async function* () {})(),
              result: Promise.resolve({ status: "completed" as const, stopReason: "end_turn" }),
              cancel: async () => {},
            };
          },
          close: async () => {},
        } as never;
      },
    });
    const config = {
      agent: "codex",
      cwd: root,
      stateDir: path.join(root, "state"),
      warmHandleIdleMs: 60_000,
    };
    const context = {
      taskId: "issue-1",
      paperclipWorkspace: { cwd: root },
    };
    const firstOnSpawn = vi.fn(async (meta: unknown) => {
      expect(meta).toEqual({ pid: processPid, processGroupId: null, startedAt });
      processIdentityPersisted = true;
    });
    const first = await execute({
      runId: "run-process-identity-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context,
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: firstOnSpawn,
    } as never);

    expect(first.exitCode).toBe(0);
    expect(firstOnSpawn).toHaveBeenCalledOnce();
    expect(turnStartedBeforeProcessIdentity).toBe(false);

    processIdentityPersisted = false;
    turnStartedBeforeProcessIdentity = false;
    const secondOnSpawn = vi.fn(async (meta: unknown) => {
      expect(meta).toEqual({ pid: processPid, processGroupId: null, startedAt });
      processIdentityPersisted = true;
    });
    const second = await execute({
      runId: "run-process-identity-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context,
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: secondOnSpawn,
    } as never);

    expect(second.exitCode).toBe(0);
    // Amendment B: the host lane closes and relaunches (no warm reuse), so the
    // second run re-creates the runtime and re-persists the process identity.
    expect(runtimeCreateCount).toBe(2);
    expect(secondOnSpawn).toHaveBeenCalledOnce();
    expect(turnStartedBeforeProcessIdentity).toBe(false);
  });

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

  it("defaults run summaries to the final output segment without thought text", async () => {
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
              text: "Let me get oriented and inspect the PRs…",
              stream: "output",
              tag: "agent_message_chunk",
            };
            yield {
              type: "text_delta",
              text: "hidden chain of thought",
              stream: "thought",
              tag: "agent_thought_chunk",
            };
            yield {
              type: "tool_call",
              text: "Bash (pending)",
              title: "Bash",
              status: "pending",
              toolCallId: "tool-1",
              tag: "tool_call",
            };
            yield {
              type: "tool_call",
              text: 'tool call (in_progress): {"command":"',
              title: "tool call",
              status: "in_progress",
              toolCallId: "tool-1",
              tag: "tool_call_update",
            };
            yield {
              type: "tool_call",
              text: "tool call (completed): apps",
              title: "tool call",
              status: "completed",
              toolCallId: "tool-1",
              tag: "tool_call_update",
            };
            yield {
              type: "text_delta",
              text: "## Update\n\n- Checked PR status\n- Continue burn-in",
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
      runId: "run-default-traits-pin",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("## Update\n\n- Checked PR status\n- Continue burn-in");
    expect(result.summary).not.toContain("Let me get oriented");
    expect(result.summary).not.toContain("hidden chain of thought");
    const toolCallEvents = logs
      .map((entry) => {
        try {
          return JSON.parse(entry.text) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((parsed): parsed is Record<string, unknown> => parsed?.type === "acpx.tool_call");
    // Every tool_call update reaches the run log — including in-progress
    // updates with the unresolved placeholder title (their name is restored
    // from the pending announcement). Nothing is coalesced or dropped for
    // agents without the coalescePlaceholderToolUpdates trait.
    expect(toolCallEvents.map((event) => [event.name, event.status])).toEqual([
      ["Bash", "pending"],
      ["Bash", "in_progress"],
      ["Bash", "completed"],
    ]);
  });

  it("does not allow configuration to include thought text in run summaries", async () => {
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
              type: "text_delta",
              text: "Let me get oriented and inspect the PRs…",
              stream: "output",
              tag: "agent_message_chunk",
            };
            yield {
              type: "text_delta",
              text: "hidden chain of thought",
              stream: "thought",
              tag: "agent_thought_chunk",
            };
            yield {
              type: "tool_call",
              text: "Bash (pending)",
              title: "Bash",
              status: "pending",
              toolCallId: "tool-1",
              tag: "tool_call",
            };
            yield {
              type: "tool_call",
              text: 'tool call (in_progress): {"command":"',
              title: "tool call",
              status: "in_progress",
              toolCallId: "tool-1",
              tag: "tool_call_update",
            };
            yield {
              type: "tool_call",
              text: "tool call (completed): apps",
              title: "tool call",
              status: "completed",
              toolCallId: "tool-1",
              tag: "tool_call_update",
            };
            yield {
              type: "text_delta",
              text: "## Update\n\n- Checked PR status\n- Continue burn-in",
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
      runId: "run-summary-last-segment",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        summaryStrategy: "full",
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("## Update\n\n- Checked PR status\n- Continue burn-in");
    expect(result.summary).not.toContain("Let me get oriented");
    expect(result.summary).not.toContain("hidden chain of thought");
  });

  it("treats a statusless initial tool call as an output-segment boundary", async () => {
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
              type: "text_delta",
              text: "Intermediate setup that must not be published",
              stream: "output",
              tag: "agent_message_chunk",
            };
            yield {
              type: "tool_call",
              text: "Bash",
              title: "Bash",
              toolCallId: "tool-without-status",
              tag: "tool_call",
            };
            yield {
              type: "tool_call",
              text: "Bash (completed)",
              title: "Bash",
              status: "completed",
              toolCallId: "tool-without-status",
              tag: "tool_call_update",
            };
            yield {
              type: "text_delta",
              text: "## Final update\n\n- Remediation verified",
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
      runId: "run-summary-statusless-tool-call",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("## Final update\n\n- Remediation verified");
    expect(result.summary).not.toContain("Intermediate setup");
  });

  it("buildAcpxRunSummary prefers the last non-empty segment", () => {
    expect(
      buildAcpxRunSummary({
        outputSegments: ["first plan", "second plan", "  final update  "],
        fallback: "end_turn",
      }),
    ).toBe("final update");
    expect(buildAcpxRunSummary({ outputSegments: ["", "  "], fallback: "end_turn" })).toBe("end_turn");
  });

  it("coalesces placeholder-title tool updates when the adapter opts in", async () => {
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
              type: "tool_call",
              text: "Bash (pending)",
              title: "Bash",
              status: "pending",
              toolCallId: "tool-1",
              tag: "tool_call",
            };
            yield {
              type: "tool_call",
              text: 'tool call (in_progress): {"command":"',
              title: "tool call",
              status: "in_progress",
              toolCallId: "tool-1",
              tag: "tool_call_update",
            };
            yield {
              type: "tool_call",
              text: 'tool call (in_progress): {"command":"ls',
              title: "tool call",
              status: "in_progress",
              toolCallId: "tool-1",
              tag: "tool_call_update",
            };
            yield {
              type: "tool_call",
              text: "Running: ls apps (in_progress)",
              title: "Running: ls apps",
              status: "in_progress",
              toolCallId: "tool-1",
              tag: "tool_call_update",
            };
            yield {
              type: "tool_call",
              text: "tool call (completed): apps\\npackage.json",
              title: "tool call",
              status: "completed",
              toolCallId: "tool-1",
              tag: "tool_call_update",
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
      runId: "run-tool-call-coalesce",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "custom",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        coalescePlaceholderToolUpdates: true,
      },
      context: {},
      onLog: async (stream: "stdout" | "stderr", text: string) => {
        logs.push({ stream, text });
      },
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    const toolCallEvents = logs
      .map((entry) => {
        try {
          return JSON.parse(entry.text) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((parsed): parsed is Record<string, unknown> => parsed?.type === "acpx.tool_call");
    // The two placeholder-title in-progress updates are dropped; the pending
    // announcement, the resolved-title in-progress update, and the terminal
    // completed update all survive.
    expect(toolCallEvents.map((event) => [event.name, event.status])).toEqual([
      ["Bash", "pending"],
      ["Running: ls apps", "in_progress"],
      ["Bash", "completed"],
    ]);
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

  it("busts the session fingerprint when the referenced-project set or pinned checkout changes", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "workspace");
    const baseConfig = { agentCommand: "node ./fake-acp.js", stateDir };

    // A compatible resume reuses the already-staged referenced-project trees, so
    // the fingerprint must fold in the referenced-project set. Otherwise a resume
    // reuses a stale tree after the set or a project's pinned checkout changes.
    const withReferenced = (additional: unknown[]) => ({
      context: {
        taskId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: { cwd, realization: { additional } },
      },
    });
    const projectA = {
      path: "/host/project-a",
      projectId: "a",
      projectWorkspaceId: "ws-a",
      repoUrl: "https://example.test/a.git",
      repoRef: "ref-a-1",
    };
    const projectB = {
      path: "/host/project-b",
      projectId: "b",
      projectWorkspaceId: "ws-b",
      repoUrl: "https://example.test/b.git",
      repoRef: "ref-b-1",
    };

    const one = await runExecutor(baseConfig, withReferenced([projectA]));
    const two = await runExecutor(baseConfig, withReferenced([projectA, projectB]));
    const reordered = await runExecutor(baseConfig, withReferenced([projectB, projectA]));
    const repointed = await runExecutor(
      baseConfig,
      withReferenced([projectA, { ...projectB, repoRef: "ref-b-2" }]),
    );

    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;

    // Adding a referenced project changes the set identity, so the fingerprint
    // busts and the next launch stages the current set.
    expect(fp(one)).toBeDefined();
    expect(fp(two)).not.toBe(fp(one));
    // The identity depends on the set, not the order the records arrive in.
    expect(fp(reordered)).toBe(fp(two));
    // Re-pinning one project's checkout ref busts the fingerprint, so the resume
    // re-stages instead of reusing a stale tree.
    expect(fp(repointed)).not.toBe(fp(two));
  });

  it("busts the session fingerprint when referenced-project files change at the same host path", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "workspace");
    const projectDir = path.join(root, "project-a");
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "src", "index.ts"), "export const value = 1;\n");
    const baseConfig = { agentCommand: "node ./fake-acp.js", stateDir };

    // Same host path and same metadata across runs. Only the file bytes change,
    // which mirrors a branch that moved or a re-checkout in place. The metadata
    // identity stays constant, so without the content signature a compatible
    // resume would reuse a stale staged tree.
    const referencedProject = {
      path: projectDir,
      projectId: "a",
      projectWorkspaceId: "ws-a",
      repoUrl: "https://example.test/a.git",
      repoRef: "main",
    };
    const withProject = () => ({
      context: {
        taskId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: { cwd, realization: { additional: [referencedProject] } },
      },
    });
    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;

    const before = await runExecutor(baseConfig, withProject());
    // Change the tree content and its size while the host path and metadata stay
    // identical.
    await fs.writeFile(path.join(projectDir, "src", "index.ts"), "export const value = 2; // changed\n");
    const afterEdit = await runExecutor(baseConfig, withProject());
    // Add a new file to the tree.
    await fs.writeFile(path.join(projectDir, "src", "extra.ts"), "export const extra = true;\n");
    const afterAdd = await runExecutor(baseConfig, withProject());

    expect(fp(before)).toBeDefined();
    // A content-only edit busts the fingerprint, so the resume re-stages.
    expect(fp(afterEdit)).not.toBe(fp(before));
    // A new file in the tree busts the fingerprint too.
    expect(fp(afterAdd)).not.toBe(fp(afterEdit));
  });

  it("busts the session fingerprint when referenced-project bytes change but size and mtime stay equal", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const cwd = path.join(root, "workspace");
    const projectDir = path.join(root, "project-a");
    const filePath = path.join(projectDir, "src", "index.ts");
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    // The two contents have the same byte length, so a stat-only signature (size
    // and modification time) would collide once the modification time also matches.
    const firstContent = "export const value = 1;\n";
    const secondContent = "export const value = 2;\n";
    expect(secondContent.length).toBe(firstContent.length);
    await fs.writeFile(filePath, firstContent);

    // A re-checkout can restore the same modification time, so pin it explicitly
    // and reapply it after the edit. Only the file bytes change between runs.
    const pinnedTime = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(filePath, pinnedTime, pinnedTime);

    const referencedProject = {
      path: projectDir,
      projectId: "a",
      projectWorkspaceId: "ws-a",
      repoUrl: "https://example.test/a.git",
      repoRef: "main",
    };
    const withProject = () => ({
      context: {
        taskId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWorkspace: { cwd, realization: { additional: [referencedProject] } },
      },
    });
    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;

    const baseConfig = { agentCommand: "node ./fake-acp.js", stateDir };
    const before = await runExecutor(baseConfig, withProject());
    // Replace the bytes with an equal-length string and restore the same
    // modification time, so path, size, and mtime all stay identical across the two runs.
    await fs.writeFile(filePath, secondContent);
    await fs.utimes(filePath, pinnedTime, pinnedTime);
    const after = await runExecutor(baseConfig, withProject());

    expect(fp(before)).toBeDefined();
    // The content signature reads bytes, so an equal-size, equal-mtime edit busts
    // the fingerprint and the resume re-stages instead of reusing a stale tree.
    expect(fp(after)).not.toBe(fp(before));
  });

  it("shapes ACPX session env for remote execution identities", async () => {
    const root = await makeTempRoot();
    const localCwd = path.join(root, "local");
    const remoteCwd = "/workspace/remote";
    const { sessionInputs, runtimeOptions } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", cwd: localCwd, stateDir: path.join(root, "state") },
      { context: { paperclipWorkspace: { cwd: localCwd, workspaceWorktreePath: localCwd } }, executionTarget: { kind: "remote", transport: "ssh", remoteCwd } },
    );
    const env = (sessionInputs[0]!.sessionOptions as { env: Record<string, string> }).env;
    expect(env.PAPERCLIP_WORKSPACE_CWD).toBe(localCwd);
    // The ssh remote transport is NOT the runner-backed process-session lane, so
    // it stays byte-identical: no host-spawn redirect. `cwd` is the host cwd and
    // `spawnCwd` is unset.
    expect(runtimeOptions[0]!.cwd).toBe(localCwd);
    expect(runtimeOptions[0]!.spawnCwd).toBeUndefined();
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
    // Local lane is byte-identical: no host-spawn redirect, so `spawnCwd` is
    // unset and acpx falls back to `cwd`.
    expect(runtimeOptions[0]!.spawnCwd).toBeUndefined();
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

    const { runtimeOptions, sessionInputs } = await runExecutor(
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

    // Host-spawn cwd decoupling: on the remote process-session lane the acpx
    // runtime host-spawns the relay proxy, whose `chdir` must land in a
    // HOST-valid dir — the engine's host `cwd` (`localCwd`) — while the advertised
    // ACP `session/new` cwd and the in-sandbox `commandPayload.cwd` stay
    // `remoteCwd`. `spawnCwd` carries the host-only redirect; it must differ from
    // the advertised session cwd. (Threading proof; the acpx runtime honoring
    // `spawnCwd ?? cwd` at the real host spawn is proven in remote-spawn-smoke.)
    expect(runtimeOptions[0]!.cwd).toBe(remoteCwd);
    expect(sessionInputs[0]!.cwd).toBe(remoteCwd);
    expect(runtimeOptions[0]!.spawnCwd).toBe(localCwd);
    expect(runtimeOptions[0]!.spawnCwd).not.toBe(sessionInputs[0]!.cwd);
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

  it("keeps the session fingerprint stable when only the host spawn cwd changes", async () => {
    // `spawnCwd` (the host-only spawn redirect = the host `cwd`) must NOT enter
    // the session fingerprint or compat key: two runs of the same session that
    // stage into the same in-sandbox `remoteCwd` from DIFFERENT host worktrees
    // must reuse — not invalidate — the staged runtime. So the fingerprint has to
    // ignore the host cwd and key only on the advertised session cwd (`remoteCwd`).
    const root = await makeTempRoot();
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(remoteCwd, { recursive: true });

    const runOnce = async (hostWorktree: string) => {
      const localCwd = path.join(root, hostWorktree);
      await fs.mkdir(localCwd, { recursive: true });
      return runExecutor(
        { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, hostWorktree, "state"), cwd: localCwd },
        {
          authToken: "real-run-jwt",
          executionTarget: {
            kind: "remote",
            transport: "sandbox",
            providerKey: "fake-plugin",
            remoteCwd,
            runner: createLocalSandboxRunner(),
          },
        },
      );
    };

    const first = await runOnce("worktree-a");
    const second = await runOnce("worktree-b");

    // Host cwd (and therefore `spawnCwd`) differs between the two runs...
    expect(first.runtimeOptions[0]!.spawnCwd).not.toBe(second.runtimeOptions[0]!.spawnCwd);
    // ...but the advertised session cwd — and thus the fingerprint — is identical.
    expect(first.sessionInputs[0]!.cwd).toBe(remoteCwd);
    expect(second.sessionInputs[0]!.cwd).toBe(remoteCwd);
    const fp = (r: { result: { sessionParams?: unknown } }) =>
      (r.result.sessionParams as { configFingerprint?: string } | undefined)?.configFingerprint;
    expect(fp(first)).toBeDefined();
    expect(fp(second)).toBe(fp(first));
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

  it("publishes referenced-project workspace hints repointed at their staged sandbox directories", async () => {
    const { root, stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    // A referenced project with a real host tree, so the sandbox transport stages it and returns a
    // `project-<projectId>` directory for it.
    const referencedProjectDir = path.join(root, "referenced-project-a");
    await fs.mkdir(referencedProjectDir, { recursive: true });
    await fs.writeFile(path.join(referencedProjectDir, "note.txt"), "referenced", "utf8");

    // Decode the process-session LAUNCH payload — the in-sandbox process env is carried there.
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
      {
        authToken: "real-run-jwt",
        executionTarget,
        context: {
          taskId: "issue-1",
          wakeReason: "issue_assigned",
          paperclipWorkspace: {
            cwd: localCwd,
            realization: {
              additional: [
                {
                  path: referencedProjectDir,
                  projectId: "a",
                  projectWorkspaceId: "ws-a",
                  repoUrl: "https://example.test/a.git",
                  repoRef: "main",
                },
              ],
            },
          },
          // The plural workspace-hints channel the agent reads. The referenced hint points at the
          // host path today; on a remote target the run must repoint it at the staged directory.
          paperclipWorkspaces: [
            {
              workspaceId: "ws-a",
              cwd: referencedProjectDir,
              repoUrl: "https://example.test/a.git",
              repoRef: "main",
              projectId: "a",
            },
          ],
        },
      },
    );

    const payloadEnv = ((launchPayload as Record<string, unknown> | null)?.env ?? {}) as Record<
      string,
      unknown
    >;
    const workspacesJson = payloadEnv.PAPERCLIP_WORKSPACES_JSON;
    expect(typeof workspacesJson).toBe("string");
    const hints = JSON.parse(String(workspacesJson)) as Array<Record<string, unknown>>;
    const referencedHint = hints.find((hint) => hint.projectId === "a");
    expect(referencedHint).toBeTruthy();
    // The referenced hint repoints from the host path to its staged in-sandbox directory.
    expect(String(referencedHint!.cwd)).toContain("project-a");
    expect(referencedHint!.cwd).not.toBe(referencedProjectDir);
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

  it("test_remote_seam_surfaces_referenced_project_staging_failure_reason", async () => {
    // A referenced project that failed to stage into the sandbox is a first-class
    // run outcome. The run result carries the failure reason for each dropped
    // project, and the run log gains one stderr line per failure that names the
    // project id and the reason. The run stays successful (per-project isolation).
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const { result, logs } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      {
        authToken: "real-run-jwt",
        executionTarget,
        prepareRemoteManagedHome: async (input) => {
          const stagedRuntime = await input.stage([]);
          // Inject a per-project staging failure the coordinator would record on a
          // real sandbox extract failure.
          stagedRuntime.additionalSourceFailures = [
            { projectId: "proj-x", error: "extract failed: boom" },
          ];
          return { stagedRuntime };
        },
      },
    );

    // The run result carries the failure with its reason.
    expect(result.referencedProjectStagingFailures).toEqual([
      { projectId: "proj-x", error: "extract failed: boom" },
    ]);
    // The run log gains one stderr line that names the project id and the reason.
    const failureLine = logs.find(
      (entry) => entry.stream === "stderr" && entry.text.includes("proj-x"),
    );
    expect(failureLine?.text).toBe(
      "[paperclip] Referenced project proj-x failed to stage; the run continues without it: extract failed: boom\n",
    );
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

  // F5 leak window 1: a seam that throws AFTER a successful stage() must not leave
  // the fresh in-sandbox runtime behind. The engine records the staged result in
  // the stage wrapper and disposes it when the seam throws.
  it("test_seam_throw_after_stage_disposes_fresh_staged_runtime", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const stagedRuntimes = new Map();
    let capturedRuntimeRoot: string | null = null;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes,
      createRuntime: () => recordingRuntime({ ensureInputs: [] }) as never,
      prepareRemoteManagedHome: async (input) => {
        const staged = await input.stage([]);
        capturedRuntimeRoot = staged.runtimeRootDir;
        // The seam fails AFTER a successful stage (e.g. an in-sandbox config
        // materialize step throws). The fresh in-sandbox runtime is already shipped.
        throw new Error("seam failed after stage");
      },
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    await expect(
      execute({ runId: "run-a", runtime: {}, ...base } as never),
    ).rejects.toThrow("seam failed after stage");

    // The stage shipped a real in-sandbox runtime root (local runner = host FS)...
    expect(typeof capturedRuntimeRoot).toBe("string");
    // ...and the seam throw disposed it, so the abandoned managed home is gone.
    expect(await pathExists(capturedRuntimeRoot!)).toBe(false);
    // The failed fresh stage was never cached for reuse.
    expect(stagedRuntimes.size).toBe(0);
  });

  // F5 leak window 2: when a bridge fails during bring-up on a resume that BORROWED
  // the cached staged runtime, the rollback must remove the borrowed cache entry
  // through the same identity guard `discardStagedRuntime` uses — else a later
  // resume reuses an entry whose host staged-temp was already disposed.
  it("test_partial_bridge_rollback_removes_borrowed_staged_entry", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const ensureInputs: Array<Record<string, unknown>> = [];
    const stagedRuntimes = new Map();
    let disposeCalls = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes,
      createRuntime: () => recordingRuntime({ ensureInputs }) as never,
      prepareRemoteManagedHome: async (input) => ({
        stagedRuntime: await input.stage([]),
        disposeStaged: async () => {
          disposeCalls += 1;
        },
      }),
    });
    const base = baseExecuteArgs({ stateDir, localCwd, executionTarget });

    const first = await execute({ runId: "run-a", runtime: {}, ...base } as never);
    expect(first.exitCode).toBe(0);
    // The clean turn cached the staged runtime for reuse; nothing disposed yet.
    expect(stagedRuntimes.size).toBe(1);
    expect(disposeCalls).toBe(0);

    // Run B resumes the same session and borrows the cached staged runtime, but a
    // bridge fails during bring-up.
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementationOnce(async () => {
      throw new Error("paperclip bridge boom");
    });
    await expect(
      execute({ runId: "run-b", runtime: { sessionParams: first.sessionParams }, ...base } as never),
    ).rejects.toThrow("paperclip bridge boom");

    // The rollback removed the borrowed cache entry through the identity guard, so a
    // later resume can never reuse an entry whose host staged-temp was disposed...
    expect(stagedRuntimes.size).toBe(0);
    // ...and it fired that entry's shared idempotent dispose exactly once.
    expect(disposeCalls).toBe(1);
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

    // Exactly one trace root, and it is the run root span.
    const roots = spans.filter((span) => span.parent === null);
    expect(roots).toHaveLength(1);
    const runRootSpan = roots[0]!;
    expect(runRootSpan.name).toBe("task.run");
    expect(runRootSpan.ended).toBe(true);

    // The sandbox bring-up span parents to the run root span.
    const startupSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(startupSpan).toBeTruthy();
    expect(startupSpan!.parent).toBe(runRootSpan);
    expect(startupSpan!.ended).toBe(true);

    // The agent turn span is a sibling of the bring-up span: it parents to the
    // run root span, not to the bring-up span.
    const turnSpan = spans.find((span) => span.name === "agent.turn");
    expect(turnSpan).toBeTruthy();
    expect(turnSpan!.parent).toBe(runRootSpan);
    expect(turnSpan!.ended).toBe(true);

    // The settlement sync-back opens the `sandbox.syncBack` span. It runs at
    // teardown, so it parents to the run root span, not to the bring-up span.
    const syncBackSpan = spans.find((span) => span.name === "sandbox.syncBack");
    expect(syncBackSpan).toBeTruthy();
    expect(syncBackSpan!.parent).toBe(runRootSpan);
    expect(syncBackSpan!.ended).toBe(true);

    // A codex bring-up over the remote sandbox lane crosses all 7 boundaries.
    // Each boundary span parents to the sandbox bring-up span, not to the run
    // root or the turn span. The `stage.sync` step also opens the two pre-task
    // sub-step spans — `snapshot.git` and `snapshot.baseline` — plus the
    // `stage.workspace` inbound task span, and the `pack` span nests one level
    // deeper under `stage.workspace`.
    const childNames = spans
      .filter(
        (span) =>
          span !== runRootSpan &&
          span !== startupSpan &&
          span !== turnSpan &&
          span !== syncBackSpan,
      )
      .map((span) => span.name)
      .sort();
    expect(childNames).toEqual(
      [
        "acp.handshake",
        "bridge.paperclip",
        "bridge.process-session",
        "codex-home.seed",
        "pack",
        "skills.reconcile",
        "snapshot.baseline",
        "snapshot.git",
        "stage.sync",
        "stage.workspace",
        "workspace.resolve",
      ],
    );

    // The two pre-task sub-step spans and the `stage.workspace` task span nest
    // under the `stage.sync` step span (that host work runs inside the step), not
    // directly under the bring-up span. The `pack` span nests under
    // `stage.workspace`, because the host builds the tarball inside the task.
    const stageSyncSpan = spans.find((span) => span.name === "stage.sync");
    const stageWorkspaceSpan = spans.find((span) => span.name === "stage.workspace");
    const packSpan = spans.find((span) => span.name === "pack");
    const snapshotGitSpan = spans.find((span) => span.name === "snapshot.git");
    const snapshotBaselineSpan = spans.find((span) => span.name === "snapshot.baseline");
    expect(stageSyncSpan).toBeTruthy();
    expect(stageWorkspaceSpan).toBeTruthy();
    expect(packSpan).toBeTruthy();
    expect(snapshotGitSpan).toBeTruthy();
    expect(snapshotBaselineSpan).toBeTruthy();
    expect(stageWorkspaceSpan!.parent).toBe(stageSyncSpan);
    expect(packSpan!.parent).toBe(stageWorkspaceSpan);
    expect(snapshotGitSpan!.parent).toBe(stageSyncSpan);
    expect(snapshotBaselineSpan!.parent).toBe(stageSyncSpan);
    expect(packSpan!.ended).toBe(true);

    // Every boundary step span parents to the sandbox bring-up span and ends.
    // The `stage.sync` sub-step spans and the run-parented `sandbox.syncBack`
    // span are the exceptions: they parent above.
    const nonStartupChildren = new Set([
      packSpan,
      stageWorkspaceSpan,
      snapshotGitSpan,
      snapshotBaselineSpan,
      syncBackSpan,
    ]);
    for (const span of spans) {
      if (span === runRootSpan || span === startupSpan || span === turnSpan) continue;
      if (nonStartupChildren.has(span)) continue;
      expect(span.parent, `span "${span.name}" must parent to the startup span`).toBe(startupSpan);
      expect(span.ended, `span "${span.name}" must end`).toBe(true);
    }
  });

  it("test_task_run_span_opens_and_ends_once_for_remote", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Run the executor with a fake remote-sandbox tracer. The engine opens one
    // `task.run` root span and ends it once at the run return.
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

    // Exactly one `task.run` span opens for a remote-sandbox run.
    const runSpans = spans.filter((span) => span.name === "task.run");
    expect(runSpans).toHaveLength(1);
    const runSpan = runSpans[0]!;
    // It is the trace root: it opens with no parent-context token.
    expect(runSpan.parent).toBeNull();
    expect(runSpan.parentContextArg).toBeUndefined();
    // It ends exactly once. A clean run sets no error status.
    expect(runSpan.ended).toBe(true);
    expect(runSpan.endCalls).toBe(1);
    expect(runSpan.status).toBeNull();
    // The run id rides only as a non-reversible hash; the raw run id never rides
    // the span.
    expect(runSpan.attributes["paperclip.task.run.run_id"]).toMatch(/^[0-9a-f]{12}$/);
    expect(String(runSpan.attributes["paperclip.task.run.run_id"])).not.toContain("run-");
  });

  it("test_sandbox_startup_parents_to_task_run", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Run the executor startup path with a fake remote-sandbox tracer. The run
    // root opens the `task.run` span first, then the startup root opens the
    // `sandbox.startup` span as its child.
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

    const runSpan = spans.find((span) => span.name === "task.run");
    expect(runSpan).toBeTruthy();
    const startupSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(startupSpan).toBeTruthy();
    // The `sandbox.startup` `startSpan` call now receives the `task.run` parent
    // context as its third argument. The recorder builds the token as
    // `{ span }`, so the token carries the run span and the startup span parents
    // to `task.run`.
    expect(startupSpan!.parentContextArg).toEqual({ span: runSpan });
    expect(startupSpan!.parent).toBe(runSpan);
  });

  it("test_task_run_span_is_noop_for_local_target", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const { traceContext, spans } = createRecordingStartupTrace();

    // A local run has no sandbox, so the run root span stays a no-op even when a
    // trace context is injected. No real `task.run` span opens.
    const { result } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", startupTraceContext: traceContext },
    );
    expect(result.exitCode).toBe(0);
    expect(spans.some((span) => span.name === "task.run")).toBe(false);
    expect(spans).toHaveLength(0);
  });

  it("test_agent_turn_span_parents_to_task_run", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Run the executor turn path with a fake remote-sandbox tracer. The engine
    // opens one `agent.turn` span around the turn as a child of `task.run` and
    // ends it once at the turn return.
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

    const runSpan = spans.find((span) => span.name === "task.run");
    expect(runSpan).toBeTruthy();
    // Exactly one `agent.turn` span opens for a remote-sandbox run.
    const turnSpans = spans.filter((span) => span.name === "agent.turn");
    expect(turnSpans).toHaveLength(1);
    const turnSpan = turnSpans[0]!;
    // The `agent.turn` `startSpan` call receives the `task.run` parent context
    // as its third argument. The recorder builds the token as `{ span }`, so the
    // turn span parents to `task.run`.
    expect(turnSpan.parentContextArg).toEqual({ span: runSpan });
    expect(turnSpan.parent).toBe(runSpan);
    // It ends exactly once. A clean turn sets no error status.
    expect(turnSpan.ended).toBe(true);
    expect(turnSpan.endCalls).toBe(1);
    expect(turnSpan.status).toBeNull();
  });

  it("test_agent_turn_span_is_noop_for_local_target", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    await fs.mkdir(localCwd, { recursive: true });
    const { traceContext, spans } = createRecordingStartupTrace();

    // A local run has no sandbox, so the turn span stays a no-op even when a
    // trace context is injected. No real `agent.turn` span opens.
    const { result } = await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", startupTraceContext: traceContext },
    );
    expect(result.exitCode).toBe(0);
    expect(spans.some((span) => span.name === "agent.turn")).toBe(false);
  });

  it("test_run_parent_getter_tracks_task_run_then_turn", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Sample `getRuntimeParentContext` at three points of the run: at runtime
    // construction (startup), inside `startTurn` (turn), and after the executor
    // resolves (post-turn). The run publishes the current-run parent token
    // through `runtimeOptions.getRuntimeParentContext`, so a fake runtime reads
    // it to prove the holder tracks `task.run`, then `agent.turn`, then
    // `task.run` again.
    let startupToken: unknown;
    let turnToken: unknown;
    let capturedGetter: (() => unknown) | undefined;
    const execute = createAcpxEngineExecutor({
      createRuntime: (options) => {
        const opts = options as unknown as { getRuntimeParentContext?: () => unknown };
        // Keep the getter for the post-turn sample after the run resolves.
        capturedGetter = opts.getRuntimeParentContext;
        // Startup phase: the holder is the `task.run` token here.
        startupToken = opts.getRuntimeParentContext?.();
        const runtime = buildRuntime();
        return {
          ...runtime,
          startTurn: (input: Record<string, unknown>) => {
            // Turn phase: the holder is the `agent.turn` token here.
            turnToken = opts.getRuntimeParentContext?.();
            return (runtime.startTurn as (input: unknown) => unknown)(input);
          },
        } as never;
      },
    });

    const result = await execute({
      runId: "run-getter",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      startupTraceContext: traceContext,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(result.exitCode).toBe(0);

    // Post-turn phase: the holder is the `task.run` token again.
    const postToken = capturedGetter?.();

    const taskRunSpan = spans.find((span) => span.name === "task.run");
    expect(taskRunSpan).toBeTruthy();
    const agentTurnSpan = spans.find((span) => span.name === "agent.turn");
    expect(agentTurnSpan).toBeTruthy();

    // The recorder builds a parent-context token as `{ span }`. So the getter
    // returns the `task.run` token during startup, the `agent.turn` token during
    // the turn, and the `task.run` token after the turn.
    expect(startupToken).toEqual({ span: taskRunSpan });
    expect(turnToken).toEqual({ span: agentTurnSpan });
    expect(postToken).toEqual({ span: taskRunSpan });
  });

  it("test_root_region_exec_parents_to_sandbox_startup", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Issue one exec from the root region of the bring-up. `getServers()` runs
    // once inside the bring-up, after the `sandbox.startup` span opens and
    // outside every measured step, so it stands in for a startup-body exec that
    // runs at the root region. The run publishes the `sandbox.startup` context to
    // the runtime-parent store for the whole bring-up, so the exec reads that
    // token here.
    const runtimeMcp = {
      getServers: () => {
        issueSandboxExecFromStore(traceContext);
        return [];
      },
    };

    await runExecutor(
      {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      {
        authToken: "real-run-jwt",
        executionTarget,
        startupTraceContext: traceContext,
        runtimeMcp: runtimeMcp as never,
      },
    );

    const startupSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(startupSpan).toBeTruthy();
    const execSpan = spans.find((span) => span.name === "sandbox.exec");
    expect(execSpan).toBeTruthy();
    // The root-region exec parents to `sandbox.startup`, not to a detached root.
    // The third `startSpan` argument is the exact `sandbox.startup` child context
    // that `contextWithSpan` built, so the exec span is a child of the bring-up.
    expect(execSpan!.parentContextArg).toEqual({ span: startupSpan });
    expect(execSpan!.parent).toBe(startupSpan);
  });

  it("test_in_step_exec_still_parents_to_step_after_root_wrap", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Issue one exec from inside the `stage.sync` step body, under the same root
    // wrap. `prepareRemoteManagedHome` runs inside the measured `stage.sync`
    // step, so the step overrides the runtime-parent store with its own context
    // there. The in-step exec must read the step context, not the root context.
    await runExecutor(
      {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      {
        authToken: "real-run-jwt",
        executionTarget,
        startupTraceContext: traceContext,
        prepareRemoteManagedHome: async (input) => {
          issueSandboxExecFromStore(traceContext);
          const stagedRuntime = await input.stage([]);
          return { stagedRuntime };
        },
      },
    );

    const stepSpan = spans.find((span) => span.name === "stage.sync");
    expect(stepSpan).toBeTruthy();
    const startupSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(startupSpan).toBeTruthy();
    const execSpan = spans.find((span) => span.name === "sandbox.exec");
    expect(execSpan).toBeTruthy();
    // The in-step exec still parents to its step span. `measureStartupStep`
    // overrides the store inside the wrap, so the step context wins over the
    // root context for an exec that runs inside the step.
    expect(execSpan!.parentContextArg).toEqual({ span: stepSpan });
    expect(execSpan!.parent).toBe(stepSpan);
    // The in-step exec does not parent to `sandbox.startup`.
    expect(execSpan!.parent).not.toBe(startupSpan);
  });

  it("records root wall / work / diff times and the bounded context on the root span", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const remoteCwd = path.join(root, "remote-workspace");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(remoteCwd, { recursive: true });
    // A plugin-backed target with a lease id. The provider clamps to `plugin`
    // and the lease id rides only as a hash.
    const executionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      leaseId: "lease-super-secret-internal-id",
      remoteCwd,
      runner: createLocalSandboxRunner(),
    };
    const { traceContext, spans } = createRecordingStartupTrace();

    await runExecutor(
      { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      { authToken: "real-run-jwt", executionTarget, startupTraceContext: traceContext },
    );

    const rootSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(rootSpan).toBeTruthy();
    // The three timing numbers are present, finite, and non-negative.
    for (const key of [A.rootWallMs, A.rootWorkMs, A.rootDiffMs]) {
      expect(typeof rootSpan!.attributes[key], `attribute ${key}`).toBe("number");
      expect(Number.isFinite(rootSpan!.attributes[key] as number)).toBe(true);
    }
    expect(rootSpan!.attributes[A.rootWorkMs] as number).toBeGreaterThanOrEqual(0);
    // A cold start (no warm handle) and the clamped provider family.
    expect(rootSpan!.attributes[A.coldStart]).toBe(true);
    expect(rootSpan!.attributes[A.provider]).toBe("plugin");
    // The lease id rides only as a non-reversible hash, never the raw value.
    expect(rootSpan!.attributes[A.leaseId]).toMatch(/^[0-9a-f]{12}$/);
    expect(String(rootSpan!.attributes[A.leaseId])).not.toContain("secret");
    // The absent region, image id, and sandbox id set no attribute (fail open).
    expect(rootSpan!.attributes).not.toHaveProperty(A.region);
    expect(rootSpan!.attributes).not.toHaveProperty(A.imageId);
    expect(rootSpan!.attributes).not.toHaveProperty(A.sandboxId);
  });

  it("excludes the nested skills.reconcile wall time from the root work sum (no double count)", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // A codex bring-up runs the codex-home.seed step, which nests skills.reconcile.
    const { events } = await runExecutor(
      {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      { authToken: "real-run-jwt", executionTarget, startupTraceContext: traceContext },
    );

    const stepEvents = events.filter((event) => event.eventType === "run.startup.step");
    // The nested skills.reconcile step still emits its own boundary event.
    const reconcile = stepEvents.find((event) => event.payload?.step === "skills.reconcile");
    expect(reconcile, "skills.reconcile must still emit its own step event").toBeTruthy();

    // The root work sum is the sum of the top-level step walls only. The nested
    // skills.reconcile wall sits inside the codex-home.seed wall, so it must not
    // ride the sum a second time. The sum of every step wall except
    // skills.reconcile equals the recorded root work sum exactly; each step
    // reports the same duration to the event and to the root accumulator.
    const sumExceptReconcile = stepEvents
      .filter((event) => event.payload?.step !== "skills.reconcile")
      .reduce((total, event) => total + (event.payload?.durationMs as number), 0);

    const rootSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(rootSpan).toBeTruthy();
    expect(rootSpan!.attributes[A.rootWorkMs]).toBe(sumExceptReconcile);
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

    const rootSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(rootSpan).toBeTruthy();
    const paperclip = spans.find((span) => span.name === "bridge.paperclip");
    const processSession = spans.find((span) => span.name === "bridge.process-session");
    expect(paperclip?.parent).toBe(rootSpan);
    expect(processSession?.parent).toBe(rootSpan);
    // Both bridge spans carry the same batch tag, so the trace marks them as one
    // parallel batch.
    expect(paperclip?.attributes[A.batch]).toBe("bridge");
    expect(processSession?.attributes[A.batch]).toBe("bridge");
    expect(paperclip?.attributes[A.batch]).toBe(processSession?.attributes[A.batch]);
  });

  it("records the handshake create-runtime and ensure-session sub-times on the acp.handshake span", async () => {
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

    const handshake = spans.find((span) => span.name === "acp.handshake");
    expect(handshake).toBeTruthy();
    // A cold start records both sub-times as finite float ms on the span.
    expect(typeof handshake!.attributes[A.handshakeCreateRuntimeWallMs]).toBe("number");
    expect(handshake!.attributes[A.handshakeCreateRuntimeWallMs] as number).toBeGreaterThanOrEqual(0);
    expect(typeof handshake!.attributes[A.handshakeEnsureSessionWallMs]).toBe("number");
    expect(handshake!.attributes[A.handshakeEnsureSessionWallMs] as number).toBeGreaterThanOrEqual(0);
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
      // The run root span and the agent turn span each use their own closed
      // allowlist; every other span uses the sandbox startup allowlist.
      const allowed =
        span.name === "task.run"
          ? ALLOWED_RUN_SPAN_ATTRIBUTE_KEYS
          : span.name === "agent.turn"
            ? ALLOWED_TURN_SPAN_ATTRIBUTE_KEYS
            : ALLOWED_STARTUP_SPAN_ATTRIBUTE_KEYS;
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(
          allowed.has(key),
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
    const rootSpan = spans.find((span) => span.name === "sandbox.startup");
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

  it("test_full_trace_tree_parents_correctly", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Drive one remote-sandbox run and issue an exec at four points of the run.
    // Each exec issues through the same host-to-sandbox seam that the run uses,
    // so the recorder captures the exact parent of each exec span. Each point
    // fires exactly once, so the run records exactly four `sandbox.exec` spans.
    let rootRegionExecFired = false;
    let syncExecFired = false;
    let turnExecFired = false;

    // A run-scoped getter holder. The engine publishes the current-run parent
    // token through `runtimeOptions.getRuntimeParentContext`. A detached site
    // reads it per unit of work and wraps the work in `runWithRuntimeParent`.
    let getRuntimeParentContext: (() => unknown) | undefined;

    const execute = createAcpxEngineExecutor({
      prepareRemoteManagedHome: async (input) => {
        // Point 2: an exec inside the measured `stage.sync` step body. The step
        // overrides the runtime-parent store, so this exec parents to the sync
        // step span, not to `sandbox.startup`.
        if (!syncExecFired) {
          syncExecFired = true;
          issueSandboxExecFromStore(traceContext);
        }
        const stagedRuntime = await input.stage([]);
        return { stagedRuntime };
      },
      createRuntime: (options) => {
        const opts = options as unknown as {
          getRuntimeParentContext?: () => unknown;
        };
        getRuntimeParentContext = opts.getRuntimeParentContext;
        const runtime = buildRuntime();
        return {
          ...runtime,
          startTurn: (input: Record<string, unknown>) => {
            // Point 3: a detached exec during the turn. The detached site reads
            // the getter (the `agent.turn` token here) and wraps the work in
            // `runWithRuntimeParent`, so the exec parents to `agent.turn`.
            if (!turnExecFired) {
              turnExecFired = true;
              runWithRuntimeParent(opts.getRuntimeParentContext?.(), () =>
                issueSandboxExecFromStore(traceContext),
              );
            }
            return (runtime.startTurn as (input: unknown) => unknown)(input);
          },
        } as never;
      },
    });

    const runtimeMcp = {
      getServers: () => {
        // Point 1: a root-region exec. `getServers` runs inside the bring-up,
        // after `sandbox.startup` opens and outside every measured step, so the
        // store holds the `sandbox.startup` context and this exec parents to it.
        if (!rootRegionExecFired) {
          rootRegionExecFired = true;
          issueSandboxExecFromStore(traceContext);
        }
        return [];
      },
    };

    const result = await execute({
      runId: "run-e2e-tree",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      runtimeMcp: runtimeMcp as never,
      startupTraceContext: traceContext,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(result.exitCode).toBe(0);

    // Point 4: a detached exec after the turn. The getter returns the `task.run`
    // token now, so an off-turn detached exec parents to `task.run`.
    runWithRuntimeParent(getRuntimeParentContext?.(), () =>
      issueSandboxExecFromStore(traceContext),
    );

    // The four framing spans of the run.
    const runSpan = spans.find((span) => span.name === "task.run");
    expect(runSpan).toBeTruthy();
    const startupSpan = spans.find((span) => span.name === "sandbox.startup");
    expect(startupSpan).toBeTruthy();
    const turnSpan = spans.find((span) => span.name === "agent.turn");
    expect(turnSpan).toBeTruthy();
    const syncStepSpan = spans.find((span) => span.name === "stage.sync");
    expect(syncStepSpan).toBeTruthy();

    // `task.run` is the trace root. `sandbox.startup` and `agent.turn` are its
    // direct children.
    expect(runSpan!.parent).toBeNull();
    expect(startupSpan!.parent).toBe(runSpan);
    expect(turnSpan!.parent).toBe(runSpan);

    // The run records exactly the four injected exec spans.
    const execSpans = spans.filter((span) => span.name === "sandbox.exec");
    expect(execSpans).toHaveLength(4);

    // A root-region exec parents to `sandbox.startup`.
    const rootRegionExec = execSpans.find((span) => span.parent === startupSpan);
    expect(rootRegionExec, "a root-region exec must parent to sandbox.startup").toBeTruthy();

    // A `stage.sync` body exec parents to the sync step, not to `sandbox.startup`.
    const syncExec = execSpans.find((span) => span.parent === syncStepSpan);
    expect(syncExec, "a stage.sync exec must parent to the sync step").toBeTruthy();
    expect(syncExec!.parent).not.toBe(startupSpan);

    // A turn detached exec parents to `agent.turn`.
    const turnExec = execSpans.find((span) => span.parent === turnSpan);
    expect(turnExec, "a turn detached exec must parent to agent.turn").toBeTruthy();

    // An off-turn detached exec parents to `task.run`.
    const offTurnExec = execSpans.find((span) => span.parent === runSpan);
    expect(offTurnExec, "an off-turn detached exec must parent to task.run").toBeTruthy();

    // The four execs are distinct spans with four distinct parents.
    const execParents = new Set([rootRegionExec, syncExec, turnExec, offTurnExec]);
    expect(execParents.size).toBe(4);
  });

  it("test_sync_back_runs_inside_sandbox_syncback_span", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // The settlement `syncBack` step runs the managed-home teardown. The teardown
    // issues one exec through the same host-to-sandbox seam the run uses. The
    // recorder captures the exec parent, so the test proves the teardown runs
    // inside the run-parented `sandbox.syncBack` span.
    let teardownExecFired = false;
    const execute = createAcpxEngineExecutor({
      prepareRemoteManagedHome: async (input) => {
        const stagedRuntime = await input.stage([]);
        return {
          stagedRuntime,
          teardown: async () => {
            if (!teardownExecFired) {
              teardownExecFired = true;
              issueSandboxExecFromStore(traceContext);
            }
          },
        };
      },
      createRuntime: () => buildRuntime() as never,
    });

    const result = await execute({
      runId: "run-sync-back-span",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      startupTraceContext: traceContext,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(result.exitCode).toBe(0);
    expect(teardownExecFired).toBe(true);

    // One `sandbox.syncBack` span opens, ends, and parents to `task.run`. The
    // settlement runs the teardown after the turn, so the run parent is
    // `task.run` at that time.
    const runSpan = spans.find((span) => span.name === "task.run");
    expect(runSpan).toBeTruthy();
    const syncBackSpans = spans.filter((span) => span.name === "sandbox.syncBack");
    expect(syncBackSpans).toHaveLength(1);
    const syncBackSpan = syncBackSpans[0]!;
    expect(syncBackSpan.ended).toBe(true);
    expect(syncBackSpan.parent).toBe(runSpan);

    // The teardown exec parents to `sandbox.syncBack`, so the sync-back copy-back
    // runs inside the span, not unparented at teardown.
    const syncBackExec = spans.find(
      (span) => span.name === "sandbox.exec" && span.parent === syncBackSpan,
    );
    expect(syncBackExec, "the teardown exec must parent to sandbox.syncBack").toBeTruthy();
  });

  it("test_no_sandbox_exec_parents_to_http_root", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const localCwd = path.join(root, "worktree");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(localCwd, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });
    const executionTarget = await remoteSandboxTarget(root);
    const { traceContext, spans } = createRecordingStartupTrace();

    // Open a top-level HTTP request span before the run. In production the run
    // opens under the HTTP request span, and the buggy exec parented to it. The
    // recorder resolves an explicit parent token to its `span`, and it resolves
    // an `undefined` token to `null`. A `sandbox.exec` issued with an `undefined`
    // token is exactly the exec that the real tracer would attach to the ambient
    // HTTP request span. So the two negatives are: no exec names this request
    // span, and no exec opens with an `undefined` token (the ambient root).
    const httpRequestSpan = traceContext.tracer.startSpan("http.request", undefined, undefined);

    let rootRegionExecFired = false;
    let syncExecFired = false;
    let turnExecFired = false;
    let getRuntimeParentContext: (() => unknown) | undefined;

    const execute = createAcpxEngineExecutor({
      prepareRemoteManagedHome: async (input) => {
        if (!syncExecFired) {
          syncExecFired = true;
          issueSandboxExecFromStore(traceContext);
        }
        const stagedRuntime = await input.stage([]);
        return { stagedRuntime };
      },
      createRuntime: (options) => {
        const opts = options as unknown as {
          getRuntimeParentContext?: () => unknown;
        };
        getRuntimeParentContext = opts.getRuntimeParentContext;
        const runtime = buildRuntime();
        return {
          ...runtime,
          startTurn: (input: Record<string, unknown>) => {
            // The detached site reads the getter and wraps the work. The getter
            // never returns `undefined` inside a live run, so this exec never
            // detaches to the HTTP request span.
            if (!turnExecFired) {
              turnExecFired = true;
              runWithRuntimeParent(opts.getRuntimeParentContext?.(), () =>
                issueSandboxExecFromStore(traceContext),
              );
            }
            return (runtime.startTurn as (input: unknown) => unknown)(input);
          },
        } as never;
      },
    });

    const runtimeMcp = {
      getServers: () => {
        if (!rootRegionExecFired) {
          rootRegionExecFired = true;
          issueSandboxExecFromStore(traceContext);
        }
        return [];
      },
    };

    const result = await execute({
      runId: "run-e2e-http",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: {
        agent: "codex",
        agentCommand: "node ./fake-acp.js",
        stateDir,
        cwd: localCwd,
        env: { CODEX_HOME: codexHome },
      },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      runtimeMcp: runtimeMcp as never,
      startupTraceContext: traceContext,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);
    expect(result.exitCode).toBe(0);

    // The off-turn detached exec also reads the getter, so it also stays under a
    // run span.
    runWithRuntimeParent(getRuntimeParentContext?.(), () =>
      issueSandboxExecFromStore(traceContext),
    );

    const execSpans = spans.filter((span) => span.name === "sandbox.exec");
    // The run issues four exec spans, so there is something to scan.
    expect(execSpans.length).toBeGreaterThan(0);

    for (const span of execSpans) {
      // Negative 1: no exec parents to the top-level HTTP request span.
      expect(span.parent, "a sandbox.exec must not parent to the HTTP request span").not.toBe(
        httpRequestSpan,
      );
      // Negative 2: no exec opens unparented inside the run. An `undefined`
      // parent token is the ambient root that would attach to the HTTP request
      // span in production, and a `null` parent is a detached span.
      expect(span.parentContextArg, "a sandbox.exec must open with an explicit parent token")
        .not.toBeUndefined();
      expect(span.parent, "a sandbox.exec must not open unparented inside the run").not.toBeNull();
    }
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

  it("emits only the high-level fields on every startup-step payload, never the detailed timing or counts", async () => {
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
    expect(steps.length).toBeGreaterThan(0);

    // Every timed boundary still records the high-level duration and outcome.
    // The detailed per-step round-trip and provider-duration numbers ride the
    // OTel spans now, so no payload carries them.
    for (const event of steps) {
      const payload = event.payload ?? {};
      expect(typeof payload.durationMs).toBe("number");
      expect(payload).not.toHaveProperty("roundTrips");
      expect(payload).not.toHaveProperty("providerExecMs");
      expect(payload).not.toHaveProperty("providerGetMs");
      expect(payload).not.toHaveProperty("createRuntimeMs");
      expect(payload).not.toHaveProperty("ensureSessionMs");
    }
  });

  it("runs a fresh acp.handshake on a compatible second run (host lane re-creates, no warm hit)", async () => {
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
    // Amendment B: the first run closed and relaunched (no warm save), so the
    // compatible second run re-creates the runtime and runs a fresh handshake — one
    // acp.handshake event whose outcome is not `skipped`.
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

    const handshakeEvents = secondEvents.filter(
      (event) => event.eventType === "run.startup.step" && event.payload?.step === "acp.handshake",
    );
    expect(handshakeEvents).toHaveLength(1);
    expect(handshakeEvents[0]!.payload?.outcome).not.toBe("skipped");
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

describe("ACPX engine run lifecycle corrections (F1: settle every failure after buildRuntime)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A remote sandbox setup that stages the host worktree through the real local
  // runner, so a run reaches the post-build window with live bridges and a held
  // staging lease.
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

  it("test_runtime_create_failure_returns_error_result_with_phase_create_runtime", async () => {
    const root = await makeTempRoot();
    const execute = createAcpxEngineExecutor({
      createRuntime: () => {
        throw new Error("createRuntime boom");
      },
    });
    const result = await execute({
      runId: "run-create-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    // The post-build runtime-creation window failure returns a settled error
    // result instead of throwing.
    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("create_runtime");
    expect(result.summary).toContain("createRuntime boom");
  });

  it("test_runtime_create_failure_stops_bridges_and_releases_staging_lease", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const paperclipStop = vi.fn(async () => {});
    const processStop = vi.fn(async () => {});
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementationOnce(
      async () => ({ env: {}, stop: paperclipStop }) as never,
    );
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementationOnce(
      async () => ({ agentCommand: null, stop: processStop }) as never,
    );
    const stagingLocks = new Map<string, Promise<unknown>>();
    const execute = createAcpxEngineExecutor({
      stagingLocks,
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () => {
        throw new Error("createRuntime boom");
      },
    });

    const result = await execute({
      runId: "run-create-fail-remote",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("create_runtime");
    // Both live bridges stop exactly once.
    expect(paperclipStop).toHaveBeenCalledTimes(1);
    expect(processStop).toHaveBeenCalledTimes(1);
    // The per-session staging lease released, so the lock map does not strand the
    // next same-session run.
    expect(stagingLocks.size).toBe(0);
  });

  it("test_prompt_build_failure_returns_error_result_with_phase_prepare_turn", async () => {
    const root = await makeTempRoot();
    const close = vi.fn(async () => {});
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          ensureSession: async () => ({
            backendSessionId: "backend-session",
            agentSessionId: "agent-session",
            runtimeSessionName: "runtime-session",
          }),
          startTurn: () => ({
            events: (async function* () {})(),
            result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
            cancel: async () => {},
          }),
          close,
        }) as never,
    });

    // A throwing accessor on a field only `buildPrompt` reads makes the prompt
    // build fail after the session handshake succeeds.
    const context: Record<string, unknown> = {};
    Object.defineProperty(context, "paperclipSessionHandoffMarkdown", {
      enumerable: false,
      get() {
        throw new Error("prompt build boom");
      },
    });

    const result = await execute({
      runId: "run-prepare-fail",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context,
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("prepare_turn");
    // The established runtime is closed on the pre-turn failure, so no session
    // leaks.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("test_sandbox_startup_span_ends_exactly_once_on_every_exit_path", async () => {
    // Each scenario runs a fresh remote bring-up with a recording trace and asserts
    // the one sandbox.startup span ends exactly once, whatever the exit path.
    const failingEnsure = () =>
      ({
        ensureSession: async () => {
          throw new Error("ensureSession boom");
        },
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never;
    const scenarios: Array<{ name: string; createRuntime: AcpxEngineExecutorOptions["createRuntime"] }> = [
      { name: "success", createRuntime: () => buildRuntime() as never },
      {
        name: "create_runtime failure",
        createRuntime: () => {
          throw new Error("createRuntime boom");
        },
      },
      { name: "ensure_session failure", createRuntime: () => failingEnsure() },
    ];

    for (const scenario of scenarios) {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      const { traceContext, spans } = createRecordingStartupTrace();
      const execute = createAcpxEngineExecutor({
        warmHandles: new Map(),
        stagedRuntimes: new Map(),
        stagingLocks: new Map(),
        createRuntime: scenario.createRuntime,
      });

      await execute({
        runId: `run-span-${scenario.name.replace(/\s+/g, "-")}`,
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

      const startupSpans = spans.filter((span) => span.name === "sandbox.startup");
      expect(startupSpans, `scenario "${scenario.name}" must open one sandbox.startup span`).toHaveLength(1);
      expect(
        startupSpans[0]!.endCalls,
        `scenario "${scenario.name}" must end the sandbox.startup span exactly once`,
      ).toBe(1);
    }
  });
});

describe("ACPX engine run lifecycle corrections (F2: close the runtime for every pre-turn failure)", () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const handle = {
    backendSessionId: "backend-session",
    agentSessionId: "agent-session",
    runtimeSessionName: "runtime-session",
  };

  it("test_persistent_host_failure_closes_recreated_runtime_no_warm_reuse", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    const closeSpy = vi.fn(async () => {});
    let created = 0;
    const warmHandles = new Map();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: (options) => {
        created += 1;
        const opts = options as AcpRuntimeOptions & {
          onAgentSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
        };
        return {
          ensureSession: async () => {
            await opts.onAgentSpawn?.({ pid: 4242, startedAt });
            return handle;
          },
          startTurn: () => ({
            events: (async function* () {})(),
            result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
            cancel: async () => {},
          }),
          close: closeSpy,
        } as never;
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
      runId: "warm-handshake-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);
    expect(first.exitCode).toBe(0);
    // Amendment B: the first clean persistent turn closes and relaunches instead of
    // warm-saving, so no warm handle survives.
    expect(warmHandles.size).toBe(0);
    expect(created).toBe(1);

    // The second run finds no warm handle, so it re-creates the runtime and fails
    // while persisting process identity.
    const second = await execute({
      runId: "warm-handshake-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {
        throw new Error("onSpawn boom");
      },
    } as never);

    expect(created).toBe(2);
    expect(second.exitCode).toBe(1);
    expect(second.resultJson?.phase).toBe("ensure_session");
    // Each run closed its own runtime (one per run); no warm entry survived.
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(warmHandles.size).toBe(0);
  });

  it("test_missing_session_handle_closes_runtime", async () => {
    const root = await makeTempRoot();
    const closeSpy = vi.fn(async () => {});
    const execute = createAcpxEngineExecutor({
      createRuntime: () =>
        ({
          // A runtime that returns no session handle drives the missing-handle path.
          ensureSession: async () => undefined,
          startTurn: () => ({
            events: (async function* () {})(),
            result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
            cancel: async () => {},
          }),
          close: closeSpy,
        }) as never,
    });

    const result = await execute({
      runId: "missing-handle",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    } as never);

    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("ensure_session");
    expect(result.errorCode).toBe("acpx_runtime_error");
    // The constructed runtime is closed so its child process cannot leak.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("test_host_lane_closes_and_relaunches_every_run_and_leaves_no_warm_entry", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "state");
    let created = 0;
    const closes: number[] = [];
    const warmHandles = new Map();
    const execute = createAcpxEngineExecutor({
      warmHandles,
      createRuntime: (options) => {
        const id = (created += 1);
        const opts = options as AcpRuntimeOptions & {
          onAgentSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
        };
        return {
          ensureSession: async () => {
            await opts.onAgentSpawn?.({ pid: 1000 + id, startedAt });
            return handle;
          },
          startTurn: () => ({
            events: (async function* () {})(),
            result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
            cancel: async () => {},
          }),
          close: async () => {
            closes.push(id);
          },
        } as never;
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
      runId: "warm-timer-1",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);
    expect(first.exitCode).toBe(0);
    // Amendment B: the first clean persistent turn closes runtime #1 and leaves no
    // warm entry, so the host lane never keeps a live runtime warm.
    expect(warmHandles.size).toBe(0);
    expect(closes).toEqual([1]);

    // The second run finds no warm entry, so it re-creates runtime #2 and fails
    // while persisting process identity; runtime #2 closes.
    const second = await execute({
      runId: "warm-timer-2",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {
        throw new Error("onSpawn boom");
      },
    } as never);
    expect(created).toBe(2);
    expect(second.exitCode).toBe(1);
    expect(closes).toEqual([1, 2]);
    expect(warmHandles.size).toBe(0);

    // A later heartbeat also finds no warm entry and constructs a fresh runtime.
    const third = await execute({
      runId: "warm-timer-3",
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: { sessionParams: first.sessionParams },
      config,
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);
    expect(third.exitCode).toBe(0);
    expect(created).toBe(3);
  });
});

describe("ACPX engine run lifecycle corrections (F3: one teardown error policy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const okHandle = {
    backendSessionId: "backend-session",
    agentSessionId: "agent-session",
    runtimeSessionName: "runtime-session",
  };

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

  // Stub both sandbox bridges with stop spies collected per start, so a test can
  // assert the bridges stopped without running the real bridge transport.
  function stubBridges() {
    const paperclipStops: Array<ReturnType<typeof vi.fn>> = [];
    const processStops: Array<ReturnType<typeof vi.fn>> = [];
    vi.mocked(startAdapterExecutionTargetPaperclipBridge).mockImplementation(async () => {
      const stop = vi.fn(async () => {});
      paperclipStops.push(stop);
      return { env: {}, stop } as never;
    });
    vi.mocked(startAdapterExecutionTargetProcessSessionBridge).mockImplementation(async () => {
      const stop = vi.fn(async () => {});
      processStops.push(stop);
      return { agentCommand: null, stop } as never;
    });
    const anyStopped = (stops: Array<ReturnType<typeof vi.fn>>) =>
      stops.some((stop) => stop.mock.calls.length > 0);
    const stoppedCount = (stops: Array<ReturnType<typeof vi.fn>>) =>
      stops.filter((stop) => stop.mock.calls.length > 0).length;
    return { paperclipStops, processStops, anyStopped, stoppedCount };
  }

  function throwingHandoffContext(): Record<string, unknown> {
    const context: Record<string, unknown> = {};
    Object.defineProperty(context, "paperclipSessionHandoffMarkdown", {
      enumerable: false,
      get() {
        throw new Error("prompt build boom");
      },
    });
    return context;
  }

  function completedTurn() {
    return {
      events: (async function* () {})(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    };
  }

  function throwingTurn() {
    return {
      events: (async function* () {
        throw new Error("turn upstream boom");
      })(),
      result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      cancel: async () => {},
    };
  }

  function remoteArgs(
    stateDir: string,
    localCwd: string,
    executionTarget: unknown,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      agent: { id: "agent-1", companyId: "company-1" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir, cwd: localCwd },
      context: {},
      authToken: "real-run-jwt",
      executionTarget,
      onLog: async () => {},
      onMeta: async () => {},
      onEvent: async () => {},
      ...overrides,
    };
  }

  it("test_teardown_continues_after_one_teardown_step_fails", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const { paperclipStops, processStops, anyStopped } = stubBridges();
    const stagingLocks = new Map<string, Promise<unknown>>();
    const logs: Array<{ stream: string; text: string }> = [];
    const execute = createAcpxEngineExecutor({
      stagingLocks,
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          // A failing teardown step must not stop the later teardown steps.
          close: async () => {
            throw new Error("close boom");
          },
        }) as never,
    });

    const result = await execute({
      runId: "td-continue",
      ...remoteArgs(stateDir, localCwd, executionTarget, {
        onLog: async (stream: "stdout" | "stderr", text: string) => {
          logs.push({ stream, text });
        },
      }),
    } as never);

    expect(result.exitCode).toBe(1);
    // The close failure did not stop the bridge stops or the lease release.
    expect(anyStopped(paperclipStops)).toBe(true);
    expect(anyStopped(processStops)).toBe(true);
    expect(stagingLocks.size).toBe(0);
    // The close failure was recorded, not silently dropped.
    expect(
      logs.some((entry) => entry.stream === "stderr" && entry.text.includes('teardown step "runtime-close" failed')),
    ).toBe(true);
  });

  it("test_staging_lease_releases_in_finally_on_every_exit_path", async () => {
    const scenarios: Array<{
      name: string;
      createRuntime: AcpxEngineExecutorOptions["createRuntime"];
      context: Record<string, unknown>;
    }> = [
      {
        name: "create_runtime",
        createRuntime: () => {
          throw new Error("createRuntime boom");
        },
        context: {},
      },
      {
        name: "ensure_session",
        createRuntime: () =>
          ({
            ensureSession: async () => {
              throw new Error("ensure boom");
            },
            startTurn: () => completedTurn(),
            close: async () => {},
          }) as never,
        context: {},
      },
      {
        name: "prepare_turn",
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => completedTurn(),
            close: async () => {},
          }) as never,
        context: throwingHandoffContext(),
      },
      {
        name: "turn",
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => throwingTurn(),
            close: async () => {},
          }) as never,
        context: {},
      },
      {
        name: "success",
        createRuntime: () =>
          ({
            ensureSession: async () => okHandle,
            startTurn: () => completedTurn(),
            close: async () => {},
          }) as never,
        context: {},
      },
    ];

    for (const scenario of scenarios) {
      const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
      stubBridges();
      const stagingLocks = new Map<string, Promise<unknown>>();
      const execute = createAcpxEngineExecutor({
        stagingLocks,
        warmHandles: new Map(),
        stagedRuntimes: new Map(),
        createRuntime: scenario.createRuntime,
      });

      await execute({
        runId: `lease-${scenario.name}`,
        ...remoteArgs(stateDir, localCwd, executionTarget, { context: scenario.context }),
      } as never).catch(() => {});

      // The staging lease is released in a finally on every exit path, so the lock
      // map never strands the next same-session run.
      expect(stagingLocks.size, `lease must release on the ${scenario.name} path`).toBe(0);
    }
  });

  it("test_result_emission_failure_does_not_skip_teardown", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const { paperclipStops, processStops, anyStopped } = stubBridges();
    const stagingLocks = new Map<string, Promise<unknown>>();
    const execute = createAcpxEngineExecutor({
      stagingLocks,
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          close: async () => {},
        }) as never,
    });

    await execute({
      runId: "emit-fail",
      ...remoteArgs(stateDir, localCwd, executionTarget, {
        // Fail the acpx.error emission only, so teardown must still run.
        onLog: async (_stream: "stdout" | "stderr", text: string) => {
          if (text.includes('"type":"acpx.error"')) throw new Error("onLog boom");
        },
      }),
    } as never).catch(() => {});

    expect(anyStopped(paperclipStops)).toBe(true);
    expect(anyStopped(processStops)).toBe(true);
    expect(stagingLocks.size).toBe(0);
  });

  it("test_result_mapping_throw_after_close_does_not_rerun_teardown", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    const { paperclipStops, processStops, stoppedCount } = stubBridges();
    let closeCount = 0;
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => ({
            events: (async function* () {
              yield { type: "done", stopReason: "end_turn" };
            })(),
            // A completed turn whose result mapping throws after the close is read.
            result: Promise.resolve({
              status: "completed",
              get stopReason(): string {
                throw new Error("mapping boom");
              },
            }),
            cancel: async () => {},
          }),
          close: async () => {
            closeCount += 1;
          },
        }) as never,
    });

    await execute({
      runId: "map-throw",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never).catch(() => {});

    // The completed turn closed the runtime once; the mapping throw did not re-run
    // the teardown through the turn catch.
    expect(closeCount).toBe(1);
    expect(stoppedCount(paperclipStops)).toBe(1);
    expect(stoppedCount(processStops)).toBe(1);
  });

  it("test_teardown_failure_does_not_change_external_result", async () => {
    const { stateDir, localCwd, executionTarget } = await setupRemoteSandbox();
    stubBridges();
    const execute = createAcpxEngineExecutor({
      warmHandles: new Map(),
      stagedRuntimes: new Map(),
      stagingLocks: new Map(),
      createRuntime: () =>
        ({
          ensureSession: async () => okHandle,
          startTurn: () => throwingTurn(),
          close: async () => {
            throw new Error("close boom");
          },
        }) as never,
    });

    const result = await execute({
      runId: "td-result",
      ...remoteArgs(stateDir, localCwd, executionTarget),
    } as never);

    // The exit cause (the turn failure) determines the external result; the failing
    // teardown step never leaks into it.
    expect(result.exitCode).toBe(1);
    expect(result.resultJson?.phase).toBe("turn");
    expect(result.errorCode).toBe("acpx_turn_failed");
    expect(result.errorMessage).toContain("turn upstream boom");
    expect(result.errorMessage).not.toContain("close boom");
  });

  it("test_flush_child_stderr_runs_on_every_exit_path", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    try {
      const scenarios: Array<{ name: string; mode: string; context: Record<string, unknown> }> = [
        { name: "ensure_session", mode: "ensure_fail", context: {} },
        { name: "prepare_turn", mode: "success", context: throwingHandoffContext() },
        { name: "turn", mode: "turn_fail", context: {} },
        { name: "success", mode: "success", context: {} },
      ];

      for (const scenario of scenarios) {
        const root = await makeTempRoot();
        const marker = `paperclip-flush-probe-${scenario.name}`;
        const execute = createAcpxEngineExecutor({
          createRuntime: (options) => {
            const opts = options as {
              onAgentStderr?: (chunk: string) => void;
            };
            // Emit a partial (newline-free) stderr chunk so it stays pending until a
            // teardown flush writes it to process.stderr.
            const emit = () => opts.onAgentStderr?.(marker);
            return {
              ensureSession: async () => {
                emit();
                if (scenario.mode === "ensure_fail") throw new Error("ensure boom");
                return okHandle;
              },
              startTurn: () =>
                scenario.mode === "turn_fail" ? throwingTurn() : completedTurn(),
              close: async () => {},
            } as never;
          },
        });

        await execute({
          runId: `flush-${scenario.name}`,
          agent: { id: "agent-1", companyId: "company-1" },
          runtime: {},
          config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state") },
          context: scenario.context,
          onLog: async () => {},
          onMeta: async () => {},
        } as never).catch(() => {});

        expect(
          writes.some((write) => write.includes(marker)),
          `flushChildStderr must run on the ${scenario.name} path`,
        ).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { Agent as HttpAgent, createServer as createHttpServer, request as requestHttp, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { getCACertificates } from "node:tls";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseOpenCodeReasoningMode, type OpenCodeReasoningMode } from "./reasoning-mode.js";

import {
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
  createCodexTaskEnvelope,
  type CodexTaskEnvelope,
} from "../../contracts/codex.js";
import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import type {
  HarnessDriver,
  HarnessDriverConfigValidation,
  HarnessDriverDescriptor,
  HarnessSession,
  HarnessSessionRecoveryResult,
  HarnessTranscriptSnapshot,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestHandoff,
  HarnessRuntimeRequestResolution,
  PaperclipQuestion,
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import {
  PAPERCLIP_QUESTION_SET_SCHEMA,
  PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
  harnessRuntimeInputExpiredOutcome,
  harnessRuntimeRequestOutcome,
  parseHarnessRuntimeRequestResolution,
  parsePaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import type {
  NativeSessionCapabilities,
  NativeUserMessage,
} from "../../contracts/types.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import {
  createProviderTraceFileSink,
  type ProviderTraceFileSink,
} from "../../contracts/provider-trace-file-sink.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { paperclipWorkspaceFileReferencesFromText } from "../../live/workspace-file-reference.js";
import {
  canonicalOpenCodeDisplayToolName,
  canonicalProviderEventsFromOpenCodePart,
  providerFamilyCapabilities,
} from "../../provider-events.js";
import {
  canonicalOpenCodeMcpToolName,
  startOpenCodeMcpBridge,
  type OpenCodeMcpBridge,
} from "./mcp-bridge.js";
import { nativeMcpLaunchBinding } from "../native-mcp.js";
import { materializeNativeRuntimeSkills } from "../runtime-context-materializer.js";
import {
  QUALIFIED_OPENCODE_V1_VERSION,
  QUALIFIED_OPENCODE_V2_VERSION,
  allowsUnqualifiedOpenCodeRunnerVersion,
  classifyOpenCodeServerInfo,
  createOpenCodeApiClient,
  isQualifiedOpenCodeVersion,
  openCodeQuestionId,
  protocolVersionForApiVersion,
  unqualifiedOpenCodeVersionMessage,
  type OpenCodeApiClient,
  type OpenCodeApiVersion,
  type OpenCodePermissionAction,
} from "./api-client.js";

export const OPENCODE_SERVER_DRIVER_KIND = "opencode_server" as const;
/** Back-compat export: the historical V1 qualification pin. */
export const QUALIFIED_OPENCODE_VERSION = QUALIFIED_OPENCODE_V1_VERSION;
export const QUALIFIED_OPENCODE_V2_RUNNER_VERSION =
  QUALIFIED_OPENCODE_V2_VERSION;
export const QUALIFIED_OPENCODE_MODEL =
  "openrouter/deepseek/deepseek-v4-flash-0731" as const;
/**
 * V2 carries the system prompt on the selected agent, so the driver defines
 * one dedicated agent instead of re-sending instructions on every prompt.
 * V1 keeps using the per-prompt `system` field.
 */
const OPEN_CODE_RUNNER_AGENT = "paperclip" as const;

/** Resolve a declared, pinned native dependency without PATH or install fallback. */
export function resolvePinnedOpenCodeCommand(
  issuer: string | URL = import.meta.url,
  target: { platform?: string; architecture?: string } = {},
): string {
  try {
    const platform = target.platform ?? process.platform;
    const architecture = target.architecture ?? process.arch;
    const packageNames: Record<string, string[]> = {
      "linux-x64": ["opencode-linux-x64-baseline"],
      "darwin-arm64": ["opencode-darwin-arm64"],
      "darwin-x64": ["opencode-darwin-x64-baseline"],
    };
    const candidates = packageNames[`${platform}-${architecture}`];
    if (!candidates) {
      throw new Error("OpenCode native target is not qualified");
    }
    const manifestPath = realpathSync(createRequire(issuer).resolve("opencode-ai/package.json"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== "opencode-ai" || manifest.version !== QUALIFIED_OPENCODE_VERSION) {
      throw new Error(`OpenCode package version mismatch: expected opencode-ai@${QUALIFIED_OPENCODE_VERSION}`);
    }
    const dependencyRequire = createRequire(manifestPath);
    for (const name of candidates) {
      if (manifest.optionalDependencies?.[name] !== QUALIFIED_OPENCODE_VERSION) {
        throw new Error("OpenCode platform dependency does not match its qualified version");
      }
      let platformManifest: string;
      try {
        platformManifest = realpathSync(dependencyRequire.resolve(`${name}/package.json`));
      } catch (error) {
        if (["MODULE_NOT_FOUND", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          continue;
        }
        throw error;
      }
      const metadata = JSON.parse(readFileSync(platformManifest, "utf8"));
      if (metadata.name !== name || metadata.version !== QUALIFIED_OPENCODE_VERSION
        || !Array.isArray(metadata.os) || !metadata.os.includes(platform)
        || !Array.isArray(metadata.cpu) || !metadata.cpu.includes(architecture)) {
        throw new Error("OpenCode installed platform artifact identity mismatch");
      }
      const root = dirname(platformManifest);
      const executable = realpathSync(resolve(root, "bin/opencode"));
      const inside = relative(root, executable);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new Error("OpenCode executable escapes its qualified platform package");
      }
      if (!statSync(executable).isFile()) {
        throw new Error("OpenCode executable is not a regular file");
      }
      accessSync(executable, constants.X_OK);
      return executable;
    }
    throw new Error("OpenCode qualified platform dependency is missing");
  } catch (error) {
    throw new Error(
      `Pinned OpenCode runtime unavailable: ${(error as Error).message}. Restore Paperclip's runtime dependencies.`,
      { cause: error },
    );
  }
}

type DynamicToolHandler = (call: {
  tool: string;
  callId: string;
  threadId: string;
  turnId: string;
  arguments: unknown;
}) => Promise<unknown>;

export type OpenCodeCompletionFeedback = (result: PrpStructuredRunResult, call: {
  tool: string;
  callId: string;
  threadId: string;
  turnId: string;
}) => Promise<string>;

export interface OpenCodeServerDriverOptions {
  model: string;
  permissionMode?: "allow" | "ask" | "deny";
  taskEnvelope?: CodexTaskEnvelope;
  conversationMode?: "task" | "prepared";
  runnerInstanceId?: string;
  command?: string;
  /** Inherited runner-owned executable descriptor duplicated into the child. */
  commandFd?: number;
  /** Runner-owned executable path lifecycle used only by the macOS proxy. */
  commandLifecycle?: {
    beforeSpawn(): void;
    afterSpawn(): void;
    afterExit?(): void;
  };
  runtimeDirectory: string;
  systemInstructions?: string;
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  environment?: NodeJS.ProcessEnv;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: DynamicToolHandler;
  completionFeedback?: OpenCodeCompletionFeedback;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Keep false when an outer supervisor already owns the process group. */
  isolateProcessGroup?: boolean;
  onDiagnostic?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

interface OpenCodeRuntime {
  baseUrl: string;
  authHeader: string;
  version: string;
  apiVersion: OpenCodeApiVersion;
  protocolVersion: "http+sse/v1" | "http+sse/v2";
  client: OpenCodeApiClient;
  permissionMode: "allow" | "ask" | "deny";
  process: ChildProcess;
  bridge: OpenCodeMcpBridge;
  trace: ProviderTraceFileSink | null;
  sensitiveValues: readonly string[];
  close(input?: {
    finalizeTrace?: boolean;
    reason?: string | null;
  }): Promise<void>;
}

/** The transport-facing subset of the runtime that `api` needs. */
interface OpenCodeApiContext {
  baseUrl: string;
  authHeader: string;
  trace: ProviderTraceFileSink | null;
  sensitiveValues: readonly string[];
}

const CAPABILITIES: NativeSessionCapabilities = {
  resume: true,
  toolRefreshOnResume: true,
  typedEvents: true,
  typedEventFamilies: providerFamilyCapabilities({
    tool_execution: "available",
    research: "available",
    delegation: "available",
    context: "available",
    artifact: "policy_disabled",
    provider_notice: "available",
  }),
  steering: false,
  interruption: true,
  structuredResult: true,
  read: true,
  reconciliation: true,
  usage: true,
  dynamicTools: true,
  runtimeRequestResolution: true,
  runtimeRequestHandoff: true,
  goals: false,
  threadLineage: false,
  unsupported: ["steering", "goals", "threadLineage"],
};

export class OpenCodeServerDriver implements HarnessDriver {
  readonly #options: OpenCodeServerDriverOptions;

  constructor(options: OpenCodeServerDriverOptions) {
    this.#options = options;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: OPENCODE_SERVER_DRIVER_KIND,
      displayName: "OpenCode server",
      version: QUALIFIED_OPENCODE_VERSION,
      protocolVersion: "http+sse/v1",
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "native",
        mcp: "native",
      },
      capabilities: structuredClone(CAPABILITIES),
    };
  }

  async validateConfig(
    config: unknown,
  ): Promise<HarnessDriverConfigValidation> {
    const candidate = isRecord(config) ? config : {};
    const issues = [];
    const model =
      typeof candidate.model === "string" ? candidate.model.trim() : "";
    if (!validModel(model))
      issues.push({
        path: "model",
        code: "invalid_model",
        message: "OpenCode model must use provider/model form.",
      });
    const command =
      typeof candidate.command === "string"
        ? candidate.command.trim()
        : "opencode";
    if (!command)
      issues.push({
        path: "command",
        code: "invalid_command",
        message: "OpenCode command cannot be empty.",
      });
    const permissionMode = candidate.permissionMode ?? "allow";
    if (
      permissionMode !== "allow" &&
      permissionMode !== "ask" &&
      permissionMode !== "deny"
    ) {
      issues.push({
        path: "permissionMode",
        code: "invalid_permission_mode",
        message: "OpenCode permission mode must be allow, ask, or deny.",
      });
    }
    return issues.length === 0
      ? { ok: true, config: { model, command, permissionMode }, issues: [] }
      : { ok: false, config: null, issues };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    return this.#open(input, null);
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    if (
      snapshot.driverKind !== OPENCODE_SERVER_DRIVER_KIND ||
      !snapshot.runId ||
      !snapshot.normalizedSessionId ||
      !snapshot.driverSessionId
    )
      return {
        recovered: false,
        reason: "persisted OpenCode session identity is incomplete",
      };
    try {
      const session = await this.#open(
        {
          runId: snapshot.runId,
          normalizedSessionId: snapshot.normalizedSessionId,
          workingDirectory: await this.#readWorkspace(
            snapshot.normalizedSessionId,
          ),
        },
        snapshot,
      );
      return { recovered: true, session };
    } catch (error) {
      return {
        recovered: false,
        reason: redact(String(error), [
          this.#options.environment?.OPENROUTER_API_KEY,
          this.#options.environment?.PAPERCLIP_AI_PROVIDER_KEY,
        ]),
      };
    }
  }

  async #readWorkspace(normalizedSessionId: string): Promise<string> {
    const raw = await readFile(
      join(
        sessionRoot(this.#options.runtimeDirectory, normalizedSessionId),
        "workspace",
      ),
      "utf8",
    );
    return raw.trim();
  }

  async #open(
    input: OpenHarnessSessionInput,
    snapshot: PersistedHarnessSession | null,
  ): Promise<HarnessSession> {
    const cwd = validateWorkspace(input.workingDirectory);
    const root = sessionRoot(
      this.#options.runtimeDirectory,
      input.normalizedSessionId,
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "workspace"), `${cwd}\n`, { mode: 0o600 });
    const trace = await createProviderTraceFileSink({
      path: this.#options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH,
      provider: "opencode",
      channel: "typescript_opencode_native",
      maxBytes: this.#options.environment?.PAPERCLIP_PROVIDER_TRACE_MAX_BYTES,
    });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let session: OpenCodeHarnessSession | null = null;
      let runtime: OpenCodeRuntime | null = null;
      try {
        runtime = await startRuntime({
          options: this.#options,
          root,
          cwd,
          trace,
          dispatch: (call) => {
            if (session === null)
              throw new Error("OpenCode session is not ready for tool calls");
            return session.dispatchTool(call);
          },
        });
        const [modelProvider, ...modelIdParts] = this.#options.model.split("/");
        const modelID = modelIdParts.join("/");
        const fetcher = this.#options.fetch ?? globalThis.fetch;
        let providerSessionId =
          snapshot?.providerSessionId ?? snapshot?.driverSessionId ?? null;
        if (providerSessionId !== null) {
          const existing = await runtime.client.getSession(providerSessionId);
          if (text(existing.id) !== providerSessionId)
            throw new Error("OpenCode resumed a different session");
        } else {
          const created = await runtime.client.createSession({
            title: `Paperclip ${input.runId}`,
            providerID: modelProvider ?? "",
            modelID,
            ...(runtime.apiVersion === "v2" ? { agent: OPEN_CODE_RUNNER_AGENT } : {}),
          });
          providerSessionId = text(created.id);
          if (!providerSessionId)
            throw new Error("OpenCode session creation omitted its id");
        }
        session = new OpenCodeHarnessSession({
          runtime,
          fetcher,
          runId: input.runId,
          normalizedSessionId: input.normalizedSessionId,
          providerSessionId,
          workingDirectory: cwd,
          runnerInstanceId:
            this.#options.runnerInstanceId ??
            `paperclip-opencode-${input.runId}`,
          model: this.#options.model,
          taskEnvelope:
            this.#options.taskEnvelope ??
            createCodexTaskEnvelope({
              objective: "Complete the supplied task.",
            }),
          conversationMode: this.#options.conversationMode,
          systemInstructions:
            this.#options.systemInstructions ??
            CODEX_SKILLLESS_BASE_INSTRUCTIONS,
          dynamicToolHandler: this.#options.dynamicToolHandler,
          completionFeedback: this.#options.completionFeedback,
          snapshot,
          now: this.#options.now ?? (() => new Date()),
        });
        session.startEventPump();
        return session;
      } catch (error) {
        lastError = error;
        await runtime?.close({ finalizeTrace: false });
        if (attempt === 3 || !retryableOpenCodeStartupError(error)) {
          await trace?.finish({ reason: "opencode_session_start_failed" });
          throw error;
        }
        this.#options.onDiagnostic?.(
          `OpenCode session startup attempt ${attempt} failed; retrying.`,
        );
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, 100 * attempt),
        );
      }
    }
    throw lastError;
  }
}

class OpenCodeHarnessSession implements HarnessSession {
  readonly #runtime: OpenCodeRuntime;
  readonly #fetch: typeof globalThis.fetch;
  #runId: string;
  readonly #normalizedSessionId: string;
  readonly #providerSessionId: string;
  readonly #workingDirectory: string;
  readonly #runnerInstanceId: string;
  readonly #model: string;
  readonly #taskEnvelope: CodexTaskEnvelope;
  readonly #systemInstructions: string;
  readonly #dynamicToolHandler?: DynamicToolHandler;
  readonly #completionFeedback?: OpenCodeCompletionFeedback;
  readonly #now: () => Date;
  readonly #events = new AsyncQueue<PrpEvent>();
  readonly #transcript: PrpEvent[] = [];
  readonly #terminalTurns = new Map<string, string>();
  readonly #seenProviderEvents = new Set<string>();
  // The turn that created each native message. A raw OpenCode frame carries
  // no turn identity of its own, so this map — not the mutable active-turn
  // pointer, which can already have moved on to a later turn by the time a
  // straggling frame for this message arrives — is the source of truth for
  // which turn a message's content belongs to.
  readonly #messageTurnIds = new Map<string, string>();
  readonly #messageRoles = new Map<string, string>();
  readonly #pendingMessageParts = new Map<
    string,
    Array<Record<string, unknown>>
  >();
  readonly #partText = new Map<string, string>();
  readonly #streamingParts = new Map<string, Record<string, unknown>>();
  readonly #completedTextPartIds = new Set<string>();
  readonly #completedReasoningPartIds = new Set<string>();
  readonly #completedTextParts: Array<{
    partId: string;
    messageId: string | null;
    text: string;
    item: Record<string, unknown>;
    observedSourceSeq: number;
  }> = [];
  readonly #messageUsageFingerprints = new Map<string, string>();
  readonly #workspaceChangesByTurn = new Map<string, Record<string, unknown>>();
  readonly #emittedFileReferences = new Set<string>();
  readonly #pendingRuntimeRequests = new Map<
    string,
    {
      request: HarnessRuntimeRequest;
      nativeQuestions: Record<string, unknown>[];
      submittedResponse?: PaperclipQuestionResponse;
      submittedAction?: "accept" | "accept_for_session" | "decline" | "cancel";
      settling?: boolean;
    }
  >();
  #activeTraceFrameId: number | null = null;
  #activeTraceEmittedEventIds: string[] = [];
  #sourceSequence: number;
  #activeTurnId: string | null;
  #result: PrpStructuredRunResult | null;
  #resultFingerprint: string | null;
  #resultCallId: string | null;
  #resultTurnId: string | null;
  #semanticResultTextBoundary: number | null = null;
  #semanticResultProviderMessageId: string | null = null;
  #lastNonTerminalToolSourceSeq = 0;
  #usage: Record<string, unknown> | null = null;
  readonly #conversationMode: "task" | "prepared";
  #sendFullContext: boolean;
  #closed = false;
  #completionSettlement: Promise<void> | null = null;
  #abort = new AbortController();

  constructor(input: {
    runtime: OpenCodeRuntime;
    fetcher: typeof globalThis.fetch;
    runId: string;
    normalizedSessionId: string;
    providerSessionId: string;
    workingDirectory: string;
    runnerInstanceId: string;
    model: string;
    conversationMode?: "task" | "prepared";
    taskEnvelope: CodexTaskEnvelope;
    systemInstructions: string;
    dynamicToolHandler?: DynamicToolHandler;
    completionFeedback?: OpenCodeCompletionFeedback;
    snapshot: PersistedHarnessSession | null;
    now: () => Date;
  }) {
    this.#runtime = input.runtime;
    this.#fetch = input.fetcher;
    this.#runId = input.runId;
    this.#sourceSequence = 0;
    this.#normalizedSessionId = input.normalizedSessionId;
    this.#providerSessionId = input.providerSessionId;
    this.#workingDirectory = input.workingDirectory;
    this.#runnerInstanceId = input.runnerInstanceId;
    this.#model = input.model;
    this.#conversationMode = input.conversationMode ?? "task";
    this.#taskEnvelope = input.taskEnvelope;
    this.#systemInstructions = input.systemInstructions;
    this.#dynamicToolHandler = input.dynamicToolHandler;
    this.#completionFeedback = input.completionFeedback;
    this.#now = input.now;
    this.#sendFullContext = input.snapshot === null && this.#conversationMode !== "prepared";
    this.#sourceSequence = input.snapshot?.lastSourceSequence ?? 0;
    this.#activeTurnId = input.snapshot?.activeTurnId ?? null;
    const restored = input.snapshot?.semanticResult ?? null;
    this.#result = restored?.result ?? null;
    this.#resultFingerprint = restored?.fingerprint ?? null;
    this.#resultCallId = restored?.callId ?? null;
    this.#resultTurnId = restored?.turnId ?? null;
    for (const terminal of input.snapshot?.terminalTurns ?? []) {
      this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    }
    if (this.#activeTurnId && this.#terminalTurns.has(this.#activeTurnId)) {
      this.#activeTurnId = null;
    }
    this.#emit(input.snapshot ? "session.resumed" : "session.started", {
      driverSessionId: input.providerSessionId,
      providerSessionId: input.providerSessionId,
      context: {
        protocolVersion: input.runtime.protocolVersion,
        opencodeVersion: input.runtime.version,
        model: input.model,
        modelProvider: input.model.split("/", 1)[0],
        workingDirectory: input.workingDirectory,
        environmentKeys: sanitizedEnvironmentKeys(),
        permissionMode: input.runtime.permissionMode,
      },
    });
    this.#emit(
      "item.completed",
      {
        kind: "model",
        text: `${input.model} (OpenCode ${input.runtime.version})`,
        model: {
          name: input.model,
          provider: input.model.split("/", 1)[0],
          opencodeVersion: input.runtime.version,
        },
      },
      { itemId: `${input.providerSessionId}:model` },
    );
  }

  ids() {
    return {
      driverSessionId: this.#providerSessionId,
      providerSessionId: this.#providerSessionId,
      displayId: this.#providerSessionId,
    };
  }

  attachRun(input: { runId: string }): void {
    if (this.#activeTurnId !== null)
      throw new Error("opencode_run_attach_busy");
    if (!input.runId) throw new Error("opencode_run_attach_invalid");
    this.#runId = input.runId;
    this.#result = null;
    this.#resultFingerprint = null;
    this.#resultCallId = null;
    this.#resultTurnId = null;
    this.#semanticResultTextBoundary = null;
    this.#semanticResultProviderMessageId = null;
    this.#lastNonTerminalToolSourceSeq = 0;
    this.#completedTextPartIds.clear();
    this.#completedReasoningPartIds.clear();
    this.#completedTextParts.length = 0;
    // `#terminalTurns` clears here for its own persisted-snapshot bookkeeping.
    // The late-frame gate in `#emit` does not depend on this map: it compares
    // against `#activeTurnId` directly, so a frame for the just-finished turn
    // stays blocked even after this new run attaches (see `#emit`).
    this.#terminalTurns.clear();
    this.#sendFullContext = false;
    this.#emit("run.attached", { runId: input.runId, sameSession: true });
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#events;
  }

  startEventPump(): void {
    void this.#recoverPendingRuntimeRequests()
      .catch((error) =>
        this.#emit("harness.diagnostic", {
          code: "opencode_runtime_request_recovery_failed",
          message: redact(String(error), this.#runtime.sensitiveValues),
        }),
      )
      .finally(() => this.#pumpEvents());
  }

  supportsTurnReasoning(): boolean {
    return this.#model.startsWith("openrouter/");
  }

  async startTurn(input: {
    message: NativeUserMessage;
    reasoningMode?: OpenCodeReasoningMode;
  }): Promise<{ turnId: string }> {
    if (this.#activeTurnId !== null)
      throw new Error("OpenCode session already has an active turn");
    const reasoningMode = parseOpenCodeReasoningMode(input.reasoningMode);
    if (input.reasoningMode !== undefined && !this.#model.startsWith("openrouter/")) {
      throw new Error("Per-turn OpenCode reasoning is supported only for OpenRouter models");
    }
    const turnId = `turn-${randomBytes(12).toString("hex")}`;
    this.#streamingParts.clear();
    this.#activeTurnId = turnId;
    this.#emit("turn.submitted", {
      envelopeSchema: this.#taskEnvelope.schema,
      text: input.message.text,
    });
    this.#emit("turn.accepted", { turnId }, { turnId });
    this.#emit("turn.started", { status: "inProgress" }, { turnId });
    const [providerID, ...modelParts] = this.#model.split("/");
    const modelID = modelParts.join("/");
    // Keep the task envelope only on the initial task-mode wake. OpenCode
    // rebuilds system instructions from the latest user message, so system
    // instructions must still accompany every prompt (including recovery).
    const prompt = this.#sendFullContext
      ? JSON.stringify({
          task: this.#taskEnvelope,
          message: input.message.text,
        })
      : input.message.text;
    await this.#runtime.client.prompt({
      sessionId: this.#providerSessionId,
      providerID,
      modelID,
      prompt,
      // OpenCode rebuilds its system instructions from the latest user message,
      // so the instructions must accompany every prompt, including recovery.
      // V2 carries them on the selected agent, so its client ignores this field.
      system: this.#systemInstructions,
      // V1 selects reasoning through the model variant; V2 carries it on the
      // selected agent, so its client ignores this field.
      ...(providerID === "openrouter"
        ? { variant: reasoningMode === "disabled" ? "paperclip-no-reasoning" : "paperclip-default" }
        : {}),
    });
    this.#sendFullContext = false;
    return { turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    await this.#completionSettlement;
    if (
      input.turnId &&
      this.#activeTurnId &&
      input.turnId !== this.#activeTurnId
    )
      throw new Error("stale OpenCode turn");
    await this.#runtime.client.interrupt(this.#providerSessionId);
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return [...this.#pendingRuntimeRequests.values()].map(({ request }) =>
      structuredClone(request),
    );
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (!pending)
      throw new Error(
        `OpenCode request ${input.requestId} is no longer pending`,
      );
    if (
      pending.request.turnId !== input.turnId ||
      this.#activeTurnId !== input.turnId
    ) {
      throw new Error(
        `OpenCode request ${input.requestId} belongs to a stale turn`,
      );
    }
    const resolution = parseHarnessRuntimeRequestResolution(
      pending.request.requestKind,
      input.resolution,
      pending.request.input,
    );
    if (pending.settling)
      throw new Error(
        `OpenCode request ${input.requestId} is already settling`,
      );
    pending.settling = true;
    const submit = async (operation: Promise<unknown>) => {
      try {
        await operation;
      } catch (error) {
        if (this.#pendingRuntimeRequests.get(input.requestId) === pending)
          pending.settling = false;
        throw error;
      }
    };
    const client = this.#runtime.client;
    if (pending.request.requestKind === "permission_approval") {
      const action: OpenCodePermissionAction =
        resolution.action === "accept" ||
        resolution.action === "accept_for_session"
          ? resolution.action
          : resolution.action === "decline" || resolution.action === "cancel"
            ? resolution.action
            : "decline";
      pending.submittedAction = action;
      await submit(
        client.replyPermission({
          sessionId: this.#providerSessionId,
          requestId: input.requestId,
          action,
        }),
      );
      if (!this.#pendingRuntimeRequests.delete(input.requestId)) return;
      this.#emit(
        "runtime_request.resolved",
        harnessRuntimeRequestOutcome(pending.request, { action }),
        {
          turnId: input.turnId,
          itemId: pending.request.itemId,
        },
      );
      return;
    }
    if (resolution.action === "submit" && "response" in resolution) {
      // OpenCode can broadcast question.replied before the reply HTTP request
      // returns. Retain the canonical response before crossing that boundary
      // so the racing terminal event carries the same durable answer record.
      pending.submittedResponse = structuredClone(resolution.response);
      await submit(
        client.replyQuestion({
          sessionId: this.#providerSessionId,
          requestId: input.requestId,
          response: resolution.response,
          nativeQuestions: pending.nativeQuestions,
          answers: openCodeAnswers(pending, resolution.response),
        }),
      );
    } else if (resolution.action === "submit" && "answers" in resolution) {
      await submit(
        client.replyQuestionAnswers({
          sessionId: this.#providerSessionId,
          requestId: input.requestId,
          nativeQuestions: pending.nativeQuestions,
          answers: resolution.answers,
        }),
      );
    } else {
      await submit(
        client.rejectQuestion({
          sessionId: this.#providerSessionId,
          requestId: input.requestId,
        }),
      );
    }
    // question.replied/question.rejected can race the HTTP response on the SSE
    // stream. The first terminal fact wins; the echo must not emit a duplicate.
    if (!this.#pendingRuntimeRequests.delete(input.requestId)) return;
    this.#emit(
      "runtime_request.resolved",
      harnessRuntimeRequestOutcome(pending.request, {
        action: resolution.action,
        ...(resolution.action === "submit" && "response" in resolution
          ? { response: resolution.response }
          : {}),
      }),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
  }

  handoffRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    signal: AbortSignal;
  }): HarnessRuntimeRequestHandoff {
    if (input.signal.aborted) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    const pending = this.#pendingRuntimeRequests.get(input.requestId);
    if (
      !pending ||
      pending.request.input === undefined ||
      pending.request.turnId !== input.turnId ||
      this.#activeTurnId !== input.turnId ||
      pending.settling ||
      pending.submittedResponse !== undefined ||
      pending.submittedAction !== undefined
    )
      return { result: "already_settled", cleanup: Promise.resolve() };
    if (!this.#pendingRuntimeRequests.delete(input.requestId)) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    this.#emit(
      "runtime_request.expired",
      harnessRuntimeInputExpiredOutcome(pending.request, input.reason),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
    const cleanup = Promise.allSettled([
      this.#runtime.client.rejectQuestion({
        sessionId: this.#providerSessionId,
        requestId: input.requestId,
      }),
      this.#runtime.client.interrupt(this.#providerSessionId),
    ]).then(() => undefined);
    return { result: "handed_off", cleanup };
  }

  async read(): Promise<Record<string, unknown>> {
    const messages = await this.#runtime.client.messages(
      this.#providerSessionId,
    );
    return { sessionId: this.#providerSessionId, messages };
  }

  async reconcile(): Promise<Record<string, unknown>> {
    const active = await this.#runtime.client.activeSessionIds();
    return {
      sessionId: this.#providerSessionId,
      status: active.has(this.#providerSessionId) ? { type: "running" } : null,
    };
  }

  async usage(): Promise<Record<string, unknown> | null> {
    return this.#usage === null ? null : structuredClone(this.#usage);
  }

  async transcript(): Promise<HarnessTranscriptSnapshot> {
    return {
      schema: "paperclip-runner/harness-transcript/v1",
      complete: true,
      eventCount: this.#transcript.length,
      events: structuredClone(this.#transcript),
      omissionReason: null,
    };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: OPENCODE_SERVER_DRIVER_KIND,
      driverSessionId: this.#providerSessionId,
      providerSessionId: this.#providerSessionId,
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      semanticResult:
        this.#result && this.#resultFingerprint && this.#resultTurnId
          ? {
              result: structuredClone(this.#result),
              fingerprint: this.#resultFingerprint,
              callId: this.#resultCallId,
              turnId: this.#resultTurnId,
            }
          : null,
      terminalTurns: [...this.#terminalTurns].map(([turnId, fingerprint]) => ({
        turnId,
        fingerprint,
      })),
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      lastSourceSequence: this.#sourceSequence,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // A controller response is authoritative. Settle its tool result before
    // closing the provider or the event stream, rather than reject after acceptance.
    await this.#completionSettlement;
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    // Settle whatever is still pending, including a request whose turn
    // already went terminal without the driver observing it (see
    // `#settlePendingRuntimeRequestsForTurn`). Bypass the terminal-turn
    // gate so each settlement event still reaches the consumer instead of
    // getting dropped as a late frame.
    for (const requestId of [...this.#pendingRuntimeRequests.keys()])
      this.#settlePendingRuntimeRequest(requestId);
    this.#events.close();
    await this.#runtime.close();
  }

  // A request can outlive its own turn: the turn can fail or get cancelled
  // while the request is still pending, which clears `#activeTurnId`
  // without settling the request. Settle any such request the moment its
  // owning turn goes terminal, before emitting the terminal turn event
  // itself, so the settlement event reaches the consumer within the same
  // turn it belongs to instead of waiting for a later, separate close.
  #settlePendingRuntimeRequestsForTurn(turnId: string): void {
    const requestIds = [...this.#pendingRuntimeRequests]
      .filter(([, pending]) => pending.request.turnId === turnId)
      .map(([requestId]) => requestId);
    for (const requestId of requestIds)
      this.#settlePendingRuntimeRequest(requestId);
  }

  #settlePendingRuntimeRequest(requestId: string): void {
    const pending = this.#pendingRuntimeRequests.get(requestId);
    if (!pending) return;
    this.#pendingRuntimeRequests.delete(requestId);
    const { request } = pending;
    this.#emit(
      request.input === undefined
        ? "runtime_request.cancelled"
        : "runtime_request.expired",
      request.input === undefined
        ? harnessRuntimeRequestOutcome(request, { reason: "session_closed" })
        : harnessRuntimeInputExpiredOutcome(request, "provider_process_lost"),
      { turnId: request.turnId, itemId: request.itemId },
      { bypassTerminalTurnGate: true },
    );
  }

  async dispatchTool(call: {
    tool: string;
    callId: string;
    arguments: unknown;
  }): Promise<unknown> {
    const tool = canonicalOpenCodeMcpToolName(call.tool);
    const turnId = this.#activeTurnId;
    if (turnId === null)
      throw new Error("OpenCode tool call is not bound to an active turn");
    this.#emit(
      "item.started",
      {
        kind: "dynamicToolCall",
        item: {
          type: "tool_call",
          id: call.callId,
          name: tool,
          arguments: call.arguments,
        },
      },
      { turnId, itemId: call.callId },
    );
    if (tool === PRP_COMPLETION_TOOL_NAME || tool === PRP_BLOCK_TOOL_NAME) {
      let settle: (() => void) | undefined;
      try {
        if (this.#closed || this.#completionSettlement)
          throw new Error("A completion is already settling or the session is closed");
        const validation = validatePrpStructuredRunResult(call.arguments);
        if (!validation.ok) throw new Error("Invalid semantic result");
        if (
          (tool === PRP_BLOCK_TOOL_NAME &&
            validation.result.reportedWorkDisposition !== "blocked") ||
          (tool === PRP_COMPLETION_TOOL_NAME &&
            validation.result.reportedWorkDisposition === "blocked")
        )
          throw new Error(
            "Semantic result disposition does not match the terminal tool",
          );
        if (
          validation.result.completionClaim.contractRevision !==
          this.#taskEnvelope.completionContract.revision
        ) {
          throw new Error(
            "Semantic result completion contract revision does not match",
          );
        }
        const expectedIds = this.#taskEnvelope.completionContract.criteria.map((criterion) => criterion.id);
        const receivedIds = validation.result.completionClaim.criteria.map((criterion) => criterion.criterionId);
        if (receivedIds.length !== expectedIds.length || new Set(receivedIds).size !== receivedIds.length || receivedIds.some((id) => !expectedIds.includes(id))) {
          // Reject at the tool boundary so the provider can repair its claim.
          // Emitting a bad result here kills runnerd's strict outer validation.
          throw new Error(`Semantic result criteria must contain exactly these criterionIds, once each: ${JSON.stringify(expectedIds)}. Keep contractRevision ${JSON.stringify(this.#taskEnvelope.completionContract.revision)}.`);
        }
        const fingerprint = canonicalJson(validation.result);
        if (this.#resultFingerprint && this.#resultFingerprint !== fingerprint)
          throw new Error("A different semantic result was already committed");
        this.#completionSettlement = new Promise<void>(resolve => { settle = resolve; });
        // Wait for the bound controller before committing or resolving the
        // provider call. A rejection remains repairable in this same turn.
        const feedback = this.#completionFeedback
          ? await this.#completionFeedback(validation.result, {
              tool, callId: call.callId, threadId: this.#providerSessionId, turnId,
            })
          : "Semantic completion accepted.";
        if (typeof feedback !== "string" || !feedback.trim())
          throw new Error("Completion feedback omitted its response text");
        if (this.#resultFingerprint && this.#resultFingerprint !== fingerprint)
          throw new Error("A different semantic result was already committed");
        if (!this.#resultFingerprint) {
          this.#result = structuredClone(validation.result);
          this.#resultFingerprint = fingerprint;
          this.#resultCallId = call.callId;
          this.#resultTurnId = turnId;
          this.#semanticResultTextBoundary = this.#completedTextParts.length;
          this.#emit("run.result.proposed", validation.result, {
            turnId,
            itemId: call.callId,
          });
        }
        this.#emit(
          "item.completed",
          {
            kind: "dynamicToolCall",
            item: {
              type: "tool_result",
              id: call.callId,
              tool_use_id: call.callId,
              result: feedback,
            },
          },
          { turnId, itemId: call.callId },
        );
        return { accepted: true, feedback };
      } catch (error) {
        // A rejected semantic call still completes its tool activity item.
        // Otherwise a later question can appear to have an in-flight tool.
        this.#emit("item.completed", {
          kind: "dynamicToolCall",
          item: { type: "tool_result", id: call.callId, tool_use_id: call.callId,
            is_error: true, error: error instanceof Error ? error.message : String(error) },
        }, { turnId, itemId: call.callId });
        throw error;
      } finally {
        if (settle) {
          this.#completionSettlement = null;
          settle();
        }
      }
    }
    if (!this.#dynamicToolHandler)
      throw new Error("Unsupported Paperclip operation");
    try {
      const result = await this.#dynamicToolHandler({
        tool,
        callId: call.callId,
        threadId: this.#providerSessionId,
        turnId,
        arguments: call.arguments,
      });
      this.#emit(
        "item.completed",
        {
          kind: "dynamicToolCall",
          item: {
            type: "tool_result",
            id: call.callId,
            tool_use_id: call.callId,
            result,
          },
        },
        { turnId, itemId: call.callId },
      );
      return result;
    } catch (error) {
      this.#emit(
        "item.completed",
        {
          kind: "dynamicToolCall",
          item: {
            type: "tool_result",
            id: call.callId,
            tool_use_id: call.callId,
            error: redact(String(error)),
            is_error: true,
          },
        },
        { turnId, itemId: call.callId },
      );
      throw error;
    }
  }

  async #recoverPendingRuntimeRequests(): Promise<void> {
    await this.#recoverPendingQuestions();
    const pending = await this.#runtime.client.listPendingPermissions();
    for (const entry of pending) {
      const sessionId = text(entry.sessionID, text(entry.sessionId));
      if (sessionId && sessionId !== this.#providerSessionId) continue;
      this.#acceptPermission(entry, "permission.recovered");
    }
  }

  async #recoverPendingQuestions(): Promise<void> {
    const pending = await this.#runtime.client.listPendingQuestions(
      this.#providerSessionId,
    );
    for (const entry of pending) {
      const question = record(entry);
      const sessionId = text(question.sessionID, text(question.sessionId));
      if (sessionId && sessionId !== this.#providerSessionId) continue;
      this.#acceptQuestion(question);
    }
  }

  #acceptQuestion(properties: Record<string, unknown>): void {
    const turnId = this.#activeTurnId;
    if (!turnId) return;
    const requestId = text(
      properties.id,
      text(properties.requestID, text(properties.requestId)),
    );
    const nativeQuestions = Array.isArray(properties.questions)
      ? properties.questions.map(record).slice(0, 64)
      : [];
    if (!requestId || nativeQuestions.length === 0) {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_rejected",
          adapter: "opencode-server",
          reason:
            "OpenCode emitted a question event without a request id or supported questions.",
        },
        { turnId, ...(requestId ? { itemId: requestId } : {}) },
      );
      return;
    }
    if (this.#pendingRuntimeRequests.has(requestId)) return;
    let input: PaperclipQuestionSet;
    try {
      input = normalizeOpenCodeQuestionSet(nativeQuestions, properties);
    } catch {
      this.#emit(
        "harness.diagnostic",
        {
          code: "runtime_input_rejected",
          adapter: "opencode-server",
          reason: "OpenCode emitted a malformed or ambiguous question set.",
        },
        { turnId, itemId: requestId },
      );
      return;
    }
    const request: HarnessRuntimeRequest = {
      requestId,
      requestKind: "user_input",
      method: "question.asked",
      turnId,
      itemId: requestId,
      status: "pending",
      prompt: "OpenCode requests user input.",
      details: {},
      input,
      origin: {
        adapter: "opencode-server",
        provider: "opencode",
        method: "question.asked",
      },
    };
    this.#pendingRuntimeRequests.set(requestId, { request, nativeQuestions });
    this.#emit(
      "runtime_request.created",
      {
        request: {
          schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
          requestKind: "runtime",
          requestId,
          type: "input",
          status: "pending",
          prompt: request.prompt,
          input,
          origin: request.origin,
          turnId,
          itemId: request.itemId,
        },
      },
      { turnId, itemId: request.itemId },
    );
  }

  #acceptPermission(properties: Record<string, unknown>, method: string): void {
    const turnId = this.#activeTurnId;
    if (!turnId) return;
    const permission = isRecord(properties.permission)
      ? properties.permission
      : isRecord(properties.request)
        ? properties.request
        : properties;
    const requestId = text(
      permission.id,
      text(
        permission.requestID,
        text(permission.requestId, text(permission.permissionID)),
      ),
    );
    if (!requestId || this.#pendingRuntimeRequests.has(requestId)) return;
    const title = text(
      permission.title,
      text(permission.permission, text(permission.tool, "requested operation")),
    );
    const request: HarnessRuntimeRequest = {
      requestId,
      requestKind: "permission_approval",
      method,
      turnId,
      itemId: requestId,
      status: "pending",
      prompt: `OpenCode requests permission for ${title}.`.slice(0, 4000),
      details: bounded(permission),
      origin: { adapter: "opencode-server", provider: "opencode", method },
    };
    this.#pendingRuntimeRequests.set(requestId, {
      request,
      nativeQuestions: [],
    });
    this.#emit(
      "runtime_request.created",
      {
        request: {
          schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
          requestKind: "runtime",
          requestId,
          type: "permission",
          status: "pending",
          prompt: request.prompt,
          actions: ["accept", "accept_for_session", "decline", "cancel"],
          details: request.details,
          origin: request.origin,
          turnId,
          itemId: request.itemId,
        },
      },
      { turnId, itemId: request.itemId },
    );
  }

  async #pumpEvents(): Promise<void> {
    let attempts = 0;
    const client = this.#runtime.client;
    while (!this.#closed && !this.#abort.signal.aborted) {
      try {
        const response = await this.#fetch(
          `${this.#runtime.baseUrl}${client.eventPath}`,
          {
            headers: {
              Authorization: this.#runtime.authHeader,
              Accept: "text/event-stream",
            },
            signal: this.#abort.signal,
          },
        );
        if (!response.ok || !response.body)
          throw new Error(
            `OpenCode event stream returned HTTP ${response.status}`,
          );
        const outboundFrameId = this.#runtime.trace?.frame({
          direction: "client_to_provider",
          raw: "",
          transport: "http_sse",
          nativeMethod: `GET ${client.eventPath}`,
        });
        if (outboundFrameId) {
          this.#runtime.trace?.interpretation({
            frameId: outboundFrameId,
            stage: "typescript_opencode_http_transport",
            ruleId: `opencode.http.GET_${safeTraceRulePath(client.eventPath)}`,
            disposition: "operator_only",
            reason: "Opened the OpenCode server-sent event stream",
          });
        }
        for await (const frame of parseSseFrames(response.body)) {
          if (this.#closed) return;
          const frameId =
            this.#runtime.trace?.frame({
              direction: "provider_to_client",
              raw: frame.raw,
              transport: "http_sse",
              nativeMethod: client.eventTraceMethod,
            }) ?? null;
          let event: unknown;
          try {
            event = JSON.parse(frame.data);
            if (frameId) {
              this.#runtime.trace?.interpretation({
                frameId,
                stage: "typescript_opencode_sse_parse",
                ruleId: "opencode.sse.json",
                disposition: "mapped",
                fieldMappings: [
                  {
                    inputPath: "$raw.data",
                    outputPath: "$providerEvent",
                    action: "normalized",
                    reason:
                      "Decoded the exact SSE data payload as an OpenCode event",
                  },
                ],
                reason: "OpenCode SSE frame parsed as JSON",
              });
            }
          } catch (error) {
            if (frameId) {
              this.#runtime.trace?.interpretation({
                frameId,
                stage: "typescript_opencode_sse_parse",
                ruleId: "opencode.sse.invalid_json",
                disposition: "rejected",
                reason: `OpenCode SSE data was not valid JSON: ${String(error).slice(0, 400)}`,
              });
            }
            throw error;
          }
          for (const providerEvent of client.normalizeEvent(event)) {
            const type = text(record(providerEvent).type);
            const properties = record(record(providerEvent).properties);
            if (
              type === "session.idle" ||
              type === "session.error" ||
              (type === "session.status" &&
                text(record(record(properties).status).type) === "idle")
            ) {
              // Do not seal the turn while its bound controller is deciding a
              // finishing call. Acceptance/rejection and the tool result must
              // precede the provider's terminal event.
              await this.#completionSettlement;
              if (this.#closed) return;
            }
            this.#mapProviderEvent(providerEvent, frameId);
          }
        }
        throw new Error(
          "OpenCode event stream closed before the session became terminal",
        );
      } catch (error) {
        if (this.#closed || this.#abort.signal.aborted) return;
        attempts += 1;
        if (attempts > 3) {
          await this.#completionSettlement;
          if (this.#closed) return;
          this.#emit("harness.diagnostic", {
            code: "opencode_sse_failed",
            message: redact(String(error), this.#runtime.sensitiveValues),
          });
          this.#events.fail(error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempts));
      }
    }
  }

  #mapProviderEvent(value: unknown, traceFrameId: number | null = null): void {
    this.#activeTraceFrameId = traceFrameId;
    this.#activeTraceEmittedEventIds = [];
    let rejected: unknown = null;
    try {
      this.#mapProviderEventValue(value);
    } catch (error) {
      rejected = error;
      throw error;
    } finally {
      if (traceFrameId) {
        const providerType = text(record(value).type, "unknown");
        this.#runtime.trace?.interpretation({
          frameId: traceFrameId,
          stage: "typescript_opencode_driver_normalization",
          ruleId: `opencode.normalize.${providerType.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
          disposition: rejected
            ? "rejected"
            : this.#activeTraceEmittedEventIds.length > 0
              ? "mapped"
              : "ignored",
          emittedEventIds: [...this.#activeTraceEmittedEventIds],
          fieldMappings:
            this.#activeTraceEmittedEventIds.length > 0
              ? [
                  {
                    inputPath: "properties",
                    outputPath: "prpEvent.payload",
                    action: "normalized",
                    reason:
                      "Mapped OpenCode event fields into canonical PRP payloads",
                  },
                ]
              : [],
          reason: rejected
            ? `OpenCode event normalization failed: ${String(rejected).slice(0, 400)}`
            : this.#activeTraceEmittedEventIds.length > 0
              ? "OpenCode event emitted one or more canonical PRP events"
              : "OpenCode event was observed but produced no canonical PRP event",
        });
      }
      this.#activeTraceFrameId = null;
      this.#activeTraceEmittedEventIds = [];
    }
  }

  #mapProviderEventValue(value: unknown): void {
    const event = record(value);
    const properties = record(event.properties);
    const type = text(event.type);
    // Id-less deltas are additive: two identical chunks can be legitimate
    // adjacent tokens. Content deduplication would silently lose the second.
    const eventId = text(event.id) || (type === "message.part.delta" ? null : canonicalJson(value));
    if (eventId !== null && this.#seenProviderEvents.has(eventId)) return;
    if (eventId !== null) this.#seenProviderEvents.add(eventId);
    if (this.#seenProviderEvents.size > 10_000)
      this.#seenProviderEvents.delete(
        this.#seenProviderEvents.values().next().value!,
      );
    const sessionId = text(
      properties.sessionID,
      text(record(properties.info).sessionID),
    );
    if (sessionId && sessionId !== this.#providerSessionId) return;
    const turnId = this.#activeTurnId;
    if (type === "question.asked" && turnId) {
      this.#acceptQuestion(properties);
      return;
    }
    if (
      (type === "permission.updated" ||
        type === "permission.asked" ||
        type === "permission.v2.asked") &&
      turnId
    ) {
      this.#acceptPermission(properties, type);
      return;
    }
    if (
      (type === "permission.replied" || type === "permission.v2.replied") &&
      turnId
    ) {
      const permission = isRecord(properties.permission)
        ? properties.permission
        : isRecord(properties.request)
          ? properties.request
          : properties;
      const requestId = text(
        permission.id,
        text(
          permission.requestID,
          text(permission.requestId, text(permission.permissionID)),
        ),
      );
      const pending = this.#pendingRuntimeRequests.get(requestId);
      if (!pending || pending.request.requestKind !== "permission_approval")
        return;
      this.#pendingRuntimeRequests.delete(requestId);
      const nativeReply = text(
        properties.reply,
        text(
          properties.response,
          text(permission.reply, text(permission.response)),
        ),
      );
      const action =
        pending.submittedAction ??
        (nativeReply === "always" || nativeReply === "always_allow"
          ? "accept_for_session"
          : nativeReply === "once" || nativeReply === "allow"
            ? "accept"
            : "decline");
      this.#emit(
        "runtime_request.resolved",
        harnessRuntimeRequestOutcome(pending.request, { action }),
        {
          turnId: pending.request.turnId,
          itemId: pending.request.itemId,
        },
      );
      return;
    }
    if (
      (type === "question.replied" || type === "question.rejected") &&
      turnId
    ) {
      const requestId = text(
        properties.id,
        text(properties.requestID, text(properties.requestId)),
      );
      const pending = this.#pendingRuntimeRequests.get(requestId);
      if (!pending) return;
      this.#pendingRuntimeRequests.delete(requestId);
      this.#emit(
        type === "question.replied"
          ? "runtime_request.resolved"
          : "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(
          pending.request,
          type === "question.replied"
            ? { action: "submit", response: pending.submittedResponse }
            : { reason: "provider_rejected" },
        ),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      return;
    }
    if (type === "message.part.updated" || type === "message.part.delta") {
      let part = record(properties.part);
      if (type === "message.part.delta") {
        const previous = this.#streamingParts.get(text(properties.partID));
        // A delta has no role or part type. Only stream text for an observed
        // part with matching message identity; never infer assistant identity.
        if (!previous || properties.field !== "text" || typeof properties.delta !== "string"
          || text(previous.messageID, text(previous.messageId)) !== text(properties.messageID)) return;
        part = { ...previous, text: text(previous.text) + properties.delta };
      }
      const messageId = text(part.messageID, text(part.messageId));
      if (!messageId) return;
      // Resolve the turn this message actually belongs to, not whichever
      // turn is active right now. A straggling part for an earlier message
      // must stay attributed to the turn that created that message.
      const owningTurnId = this.#messageTurnIds.get(messageId) ?? turnId;
      if (!owningTurnId) return;
      if (owningTurnId === turnId && text(part.id) && ["text", "reasoning"].includes(text(part.type))) {
        this.#streamingParts.set(text(part.id), part);
      }
      const role = this.#messageRoles.get(messageId);
      if (role === "assistant") this.#emitAssistantPart(part, owningTurnId);
      else if (role === undefined) {
        const pending = this.#pendingMessageParts.get(messageId) ?? [];
        // Text deltas are cumulative by this point. Keep the newest snapshot
        // (including completion metadata), not the first 100 token chunks.
        const previousIndex = ["text", "reasoning"].includes(text(part.type)) && text(part.id)
          ? pending.findIndex(candidate => candidate.id === part.id && candidate.type === part.type)
          : -1;
        if (previousIndex >= 0) pending[previousIndex] = part;
        else if (pending.length < 100) pending.push(part);
        this.#pendingMessageParts.set(messageId, pending);
      }
      return;
    }
    if (type === "message.updated") {
      const info = record(properties.info);
      const messageId = text(
        info.id,
        text(info.messageID, text(info.messageId)),
      );
      const role = text(info.role);
      // Record the message's owning turn at the moment OpenCode first
      // reports it. A later turn that reuses the same native message id
      // legitimately reclaims ownership; a stale message never sees this
      // branch again, so its recorded owner never changes.
      if (messageId && role && turnId) this.#messageTurnIds.set(messageId, turnId);
      const owningTurnId = messageId
        ? (this.#messageTurnIds.get(messageId) ?? turnId)
        : turnId;
      if (!owningTurnId) return;
      if (messageId && role) {
        this.#messageRoles.set(messageId, role);
        const pending = this.#pendingMessageParts.get(messageId) ?? [];
        this.#pendingMessageParts.delete(messageId);
        if (role === "assistant")
          for (const part of pending)
            this.#emitAssistantPart(part, owningTurnId);
      }
      const tokens = record(info.tokens);
      if (
        role === "assistant" &&
        (Object.keys(tokens).length > 0 || typeof info.cost === "number")
      ) {
        this.#usage = bounded({
          ...tokens,
          costUsd: info.cost ?? null,
          model: this.#model,
          provider: this.#model.split("/", 1)[0],
          driverVersion: this.#runtime.version,
        });
        const usageFingerprint = canonicalJson(this.#usage);
        const hasMeaningfulUsage =
          hasPositiveNumber(tokens) ||
          (typeof info.cost === "number" && info.cost > 0);
        if (
          hasMeaningfulUsage &&
          this.#messageUsageFingerprints.get(messageId) !== usageFingerprint
        ) {
          this.#messageUsageFingerprints.set(messageId, usageFingerprint);
          this.#emit(
            "item.completed",
            { kind: "usage", usage: this.#usage, usageMessageId: messageId },
            { turnId: owningTurnId, itemId: `${owningTurnId}:usage` },
          );
        }
      }
      return;
    }
    if (
      (type === "session.idle" ||
        (type === "session.status" &&
          text(record(properties.status).type) === "idle")) &&
      turnId
    ) {
      const fingerprint = canonicalJson({
        status: "completed",
        semanticResult: this.#resultFingerprint,
      });
      this.#terminalTurns.set(turnId, fingerprint);
      this.#emitSettledFinalAgentMessage(turnId);
      const workspace = this.#workspaceChangesByTurn.get(turnId);
      if (workspace !== undefined)
        this.#emit(
          "workspace.diff.recorded",
          { ...workspace, complete: true },
          { turnId, itemId: `${turnId}:workspace` },
        );
      // Settle any request this turn never answered before the terminal
      // event, so a consumer that stops reading at that terminal event still
      // observes the settlement.
      this.#settlePendingRuntimeRequestsForTurn(turnId);
      // Emit while this turn is still `#activeTurnId`; the gate in `#emit`
      // drops any frame whose turnId is not the active turn, so nulling it
      // first would make `#emit` drop this very event.
      this.#emit("turn.completed", { status: "completed" }, { turnId });
      this.#activeTurnId = null;
      return;
    }
    if (type === "session.error" && turnId) {
      const providerError = record(properties.error);
      const providerErrorData = record(providerError.data);
      if (
        text(providerError.name) === "MessageAbortedError" &&
        text(providerErrorData.message, text(providerError.message)) ===
          "Aborted"
      ) {
        // OpenCode reports its normal /abort control path as session.error. That
        // endpoint is also how Paperclip parks a provider turn after a durable
        // governed interaction is created, so presenting it as a provider
        // failure produces a false red error immediately above a healthy wait
        // card. Preserve the provider fact as a cancelled terminal event; the
        // native session loop independently commits the authoritative yielded
        // result when this abort followed a governed wait.
        // Settle any request this turn never answered before the terminal
        // event, so a consumer that stops reading at that terminal event
        // still observes the settlement.
        this.#settlePendingRuntimeRequestsForTurn(turnId);
        this.#emit(
          "turn.cancelled",
          {
            status: "cancelled",
            error: bounded(properties.error ?? properties),
          },
          { turnId },
        );
        this.#terminalTurns.set(turnId, canonicalJson({ status: "cancelled" }));
        this.#activeTurnId = null;
        return;
      }
      this.#emit(
        "provider.notice.recorded",
        {
          schema: "paperclip.provider.notice.v1",
          noticeId: `${turnId}:session-error`,
          severity: "error",
          category: "session_error",
          scope: "turn",
          recoverable: false,
          userActionable: true,
          summary: redact(
            text(record(properties.error).message, "OpenCode session failed."),
            this.#runtime.sensitiveValues,
          ).slice(0, 4000),
        },
        { turnId, itemId: `${turnId}:session-error` },
      );
      // Settle any request this turn never answered before the terminal
      // event, so a consumer that stops reading at that terminal event still
      // observes the settlement.
      this.#settlePendingRuntimeRequestsForTurn(turnId);
      this.#emit(
        "turn.failed",
        { status: "failed", error: bounded(properties.error ?? properties) },
        { turnId },
      );
      this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
      this.#activeTurnId = null;
    }
  }

  #emitAssistantPart(part: Record<string, unknown>, turnId: string): void {
    const partId = text(part.id, `${turnId}:part`);
    const partType = text(part.type, "unknown");
    const messageId = text(part.messageID, text(part.messageId)) || null;
    const canonicalToolName = canonicalOpenCodeMcpToolName(
      canonicalOpenCodeDisplayToolName(
        text(part.tool, text(part.name)),
        text(part.callID, text(part.callId)),
      ),
    );
    if (
      ["tool", "tool-call", "tool_call"].includes(partType) &&
      [PRP_COMPLETION_TOOL_NAME, PRP_BLOCK_TOOL_NAME].includes(
        canonicalToolName as typeof PRP_COMPLETION_TOOL_NAME,
      ) &&
      messageId
    ) {
      // OpenCode may report the terminal MCP call before it marks the text
      // part from the same assistant message complete. Correlating by native
      // message identity selects that response while excluding both earlier
      // commentary messages and later acknowledgement-only messages.
      this.#semanticResultProviderMessageId = messageId;
    }
    for (const canonical of canonicalProviderEventsFromOpenCodePart(part)) {
      this.#emit(canonical.eventType, canonical.payload, {
        turnId,
        itemId: canonical.itemId,
      });
    }
    if (
      ["tool", "tool-call", "tool_call"].includes(partType) &&
      ![PRP_COMPLETION_TOOL_NAME, PRP_BLOCK_TOOL_NAME].includes(
        canonicalToolName as typeof PRP_COMPLETION_TOOL_NAME,
      )
    ) {
      this.#lastNonTerminalToolSourceSeq = this.#sourceSequence;
    }
    if (partType === "patch") {
      const paths = Array.isArray(part.files) ? part.files : [];
      const files = paths
        .slice(0, 2_000)
        .flatMap((value): Record<string, unknown>[] => {
          const path = text(value).replaceAll("\\", "/");
          if (!path || path.startsWith("/") || path.split("/").includes(".."))
            return [];
          return [
            {
              path,
              operation: "modify",
              previousPath: null,
              additions: null,
              deletions: null,
              binary: false,
              diff: null,
            },
          ];
        });
      if (files.length > 0) {
        const previous = this.#workspaceChangesByTurn.get(turnId);
        const payload = {
          schema: "paperclip.workspace.diff.v1",
          changeSetId: `${turnId}:workspace`,
          revision: Number(record(previous).revision ?? 0) + 1,
          source: "harness_reported",
          complete: false,
          files,
          totals: { files: files.length, additions: null, deletions: null },
          patchArtifactRef: null,
        };
        this.#workspaceChangesByTurn.set(turnId, payload);
        this.#emit("workspace.change.updated", payload, {
          turnId,
          itemId: `${turnId}:workspace`,
        });
      }
    }
    const content = text(part.text, text(part.output));
    const previous = this.#partText.get(partId) ?? "";
    this.#partText.set(partId, content);
    if (partType === "text" && content.length > 0) {
      for (const reference of paperclipWorkspaceFileReferencesFromText(
        this.#workingDirectory,
        content,
        turnId,
      )) {
        if (this.#emittedFileReferences.has(reference.referenceId)) continue;
        this.#emittedFileReferences.add(reference.referenceId);
        this.#emit(
          "workspace.file.referenced",
          { ...reference },
          { turnId, itemId: reference.referenceId },
        );
      }
    }
    const delta = content.startsWith(previous)
      ? content.slice(previous.length)
      : content;
    if (delta) {
      // OpenCode calls assistant prose a `text` part, but `text` is not a PRP
      // item identity and is consequently ignored by the task projection.
      // Until settlement selects one completed part as the final response,
      // every assistant text update is canonical progress/commentary.
      const assistantDelta = partType === "text";
      const reasoningDelta = partType === "reasoning";
      this.#emit(
        "item.delta",
        {
          kind: assistantDelta
            ? "agentMessage"
            : reasoningDelta
              ? "reasoning"
              : partType,
          ...(assistantDelta
            ? { channel: "progress", providerPhase: "commentary" }
            : reasoningDelta
              ? { channel: "detail", providerPhase: "reasoning" }
              : {}),
          text: delta,
          item: bounded(
            assistantDelta
              ? {
                  ...part,
                  type: "agentMessage",
                  channel: "progress",
                  phase: "commentary",
                  text: delta,
                }
              : reasoningDelta
                ? {
                    ...part,
                    type: "reasoning",
                    channel: "detail",
                    phase: "reasoning",
                    text: delta,
                  }
                : part,
          ),
        },
        { turnId, itemId: partId },
      );
    }
    const completedAt = record(part.time).end;
    if (
      partType === "reasoning" &&
      content.trim().length > 0 &&
      Number.isFinite(completedAt) &&
      !this.#completedReasoningPartIds.has(partId)
    ) {
      this.#completedReasoningPartIds.add(partId);
      this.#emit(
        "item.completed",
        {
          kind: "reasoning",
          channel: "detail",
          providerPhase: "reasoning",
          text: content,
          item: bounded({
            ...part,
            type: "reasoning",
            channel: "detail",
            phase: "reasoning",
            text: content,
          }),
        },
        { turnId, itemId: partId },
      );
    }
    if (
      partType === "text" &&
      content.trim().length > 0 &&
      Number.isFinite(completedAt) &&
      !this.#completedTextPartIds.has(partId)
    ) {
      this.#completedTextPartIds.add(partId);
      this.#completedTextParts.push({
        partId,
        messageId,
        text: content,
        item: bounded({
          ...part,
          type: "agentMessage",
          phase: "final_answer",
          text: content,
        }),
        observedSourceSeq: this.#sourceSequence,
      });
    }
  }

  #emitSettledFinalAgentMessage(turnId: string): void {
    // OpenCode labels every assistant text part as plain `text`; unlike Codex,
    // it does not provide commentary/final-answer channels. A single native
    // assistant message can therefore contain an opening progress note, many
    // work tools, and the terminal MCP call. Do not promote that opening note
    // into the settled response merely because it shares the terminal call's
    // message id. Only text observed after the last non-terminal work tool can
    // be a final response. When no such text exists, emit no final agentMessage
    // and let the accepted semantic summary resolve the durable reply.
    const afterLastWorkTool = (part: { observedSourceSeq: number }) =>
      part.observedSourceSeq > this.#lastNonTerminalToolSourceSeq;
    const eligibleText = this.#completedTextParts.filter(afterLastWorkTool);
    // OpenCode exposes no prose channel, so final selection must use provider
    // structure rather than text length or content. When OpenCode reports the
    // terminal tool part, prefer prose completed afterward in that exact
    // provider message. If that message contains only pre-tool commentary,
    // the first later assistant message is the compatible terminal response.
    // Without a reported tool-message identity, a completed pre-tool message
    // is more authoritative than a later acknowledgement; otherwise the first
    // post-tool message is the only available compatibility fallback.
    const indexed = eligibleText.map((part) => ({
      part,
      index: this.#completedTextParts.indexOf(part),
    }));
    const boundary = this.#semanticResultTextBoundary;
    const beforeResult = indexed.filter(
      ({ index }) => boundary !== null && index < boundary,
    );
    const afterResult = indexed.filter(
      ({ index }) => boundary === null || index >= boundary,
    );
    const correlatedAfterResult =
      this.#semanticResultProviderMessageId === null
        ? []
        : afterResult.filter(
            ({ part }) =>
              part.messageId === this.#semanticResultProviderMessageId,
          );
    const uncorrelatedAfterResult =
      this.#semanticResultProviderMessageId === null
        ? afterResult
        : afterResult.filter(
            ({ part }) =>
              part.messageId !== this.#semanticResultProviderMessageId,
          );
    const selected =
      correlatedAfterResult.at(-1)?.part ??
      (this.#semanticResultProviderMessageId === null
        ? beforeResult.at(-1)?.part
        : uncorrelatedAfterResult[0]?.part) ??
      beforeResult.at(-1)?.part ??
      afterResult[0]?.part ??
      null;
    if (!selected) return;
    this.#emit(
      "item.completed",
      {
        kind: "agentMessage",
        channel: "final",
        providerPhase: "final_answer",
        text: selected.text,
        item: selected.item,
      },
      { turnId, itemId: selected.partId },
    );
  }

  #emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
    options?: { bypassTerminalTurnGate?: boolean },
  ): void {
    if (
      !options?.bypassTerminalTurnGate &&
      eventType !== "harness.diagnostic" &&
      refs.turnId !== undefined &&
      refs.turnId !== this.#activeTurnId
    ) {
      // The provider sent this frame for a turn that is not the current
      // active turn, so that turn already reached a terminal state: turns
      // run strictly one at a time (`startTurn` and `attachRun` both refuse
      // to proceed while `#activeTurnId` is set), and a turn id is never
      // reused. Comparing directly against `#activeTurnId` needs no history
      // of past turns, so the gate stays correct and its memory stays O(1)
      // no matter how many turns a long-lived session runs. The queue stays
      // open across turns, so a silent drop here would let a stale frame
      // reach the next turn's consumer. Report it instead of discarding it
      // without a trace.
      this.#emit("harness.diagnostic", {
        code: "opencode_late_terminal_turn_event_dropped",
        message: `OpenCode sent a ${eventType} event for a turn that already reached a terminal state.`,
        droppedEventType: eventType,
        turnId: refs.turnId,
      });
      return;
    }
    const sourceSeq = ++this.#sourceSequence;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    };
    if (this.#activeTraceFrameId !== null) {
      this.#activeTraceEmittedEventIds.push(event.sourceEventId);
    }
    this.#transcript.push(structuredClone(event));
    this.#events.push(event);
  }
}

/** Retain the reusable gateway key in the runner; the harness gets a session-scoped capability. */
async function startOpenCodeProviderProxy(baseUrl: string, key: string, model: string, environment: NodeJS.ProcessEnv) {
  const upstreamUrl = new URL(`${baseUrl.replace(/\/+$/, "")}/chat/completions`);
  const token = randomBytes(32).toString("base64url");
  // Agent-local settings keep one runtime's transport configuration out of other sessions.
  const proxyEnv = {
    HTTP_PROXY: environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    HTTPS_PROXY: environment.https_proxy ?? environment.HTTPS_PROXY ?? environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    NO_PROXY: environment.no_proxy ?? environment.NO_PROXY,
  };
  const ca = [...getCACertificates("default")];
  if (environment.SSL_CERT_FILE) ca.push(await readFile(environment.SSL_CERT_FILE, "utf8"));
  if (environment.SSL_CERT_DIR) {
    for (const entry of await readdir(environment.SSL_CERT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        const certificate = await readFile(join(environment.SSL_CERT_DIR, entry.name), "utf8");
        if (certificate.includes("-----BEGIN CERTIFICATE-----")) ca.push(certificate);
      }
    }
  }
  const agent = upstreamUrl.protocol === "https:" ? new HttpsAgent({ proxyEnv, ca }) : new HttpAgent({ proxyEnv });
  const controllers = new Set<AbortController>();
  const server = createHttpServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    response.once("close", () => controller.abort());
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { response.writeHead(400).end(); return; }
      if (!payload || typeof payload !== "object" || payload.model !== model) {
        response.writeHead(400).end();
        return;
      }
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = (upstreamUrl.protocol === "https:" ? requestHttps : requestHttp)(upstreamUrl, {
          method: "POST",
          agent,
          headers: { "Content-Type": "application/json", "Content-Length": body.length, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
        }, resolve);
        outgoing.once("error", reject);
        outgoing.end(body);
      });
      // Never forward authentication to a redirect destination.
      const status = upstream.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstream.destroy();
        throw new Error("Provider redirects are not supported");
      }
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "content-encoding", "cache-control", "retry-after"]) {
        const value = upstream.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      response.writeHead(status, headers);
      await pipeline(upstream, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502).end("Provider request failed");
      else response.destroy();
    }).finally(() => controllers.delete(controller));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { agent.destroy(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    agent.destroy();
    throw new Error("Could not bind OpenCode provider proxy");
  }
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    token,
    close: async () => {
      for (const controller of controllers) controller.abort();
      agent.destroy();
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

async function startRuntime(input: {
  options: OpenCodeServerDriverOptions;
  root: string;
  cwd: string;
  trace: ProviderTraceFileSink | null;
  dispatch: (call: {
    tool: string;
    callId: string;
    arguments: unknown;
  }) => Promise<unknown>;
}): Promise<OpenCodeRuntime> {
  const port = await reservePort();
  const password = randomBytes(32).toString("base64url");
  const username = "opencode";
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const configHome = join(input.root, "config");
  const dataHome = join(input.root, "data");
  const cacheHome = join(input.root, "cache");
  await Promise.all([
    mkdir(join(configHome, "opencode"), { recursive: true, mode: 0o700 }),
    mkdir(dataHome, { recursive: true, mode: 0o700 }),
    mkdir(cacheHome, { recursive: true, mode: 0o700 }),
  ]);
  // HOME contains a read-only skill snapshot, whose destination must be fresh.
  // Keep OpenCode's XDG data stable for provider-session recovery while giving
  // every launch (including retries and recovery) a new isolated HOME.
  const isolatedHome = await mkdtemp(join(input.root, "home-"));
  await chmod(isolatedHome, 0o700);
  try {
    await materializeNativeRuntimeSkills(
      input.options.runtimeContext ?? null,
      join(isolatedHome, ".claude", "skills"),
    );
  } catch (error) {
    await rm(isolatedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  const bridge = await startOpenCodeMcpBridge({
    tools: input.options.dynamicTools,
    handler: input.dispatch,
  }).catch(async (error) => {
    await rm(isolatedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  });
  const assignedMcp = nativeMcpLaunchBinding(
    input.options.environment ?? process.env,
  );
  const identityKey = input.options.environment?.PAPERCLIP_AGENT_PRIVATE_KEY;
  const identityValues = identityKey ? [identityKey, JSON.stringify(identityKey).slice(1, -1),
    ...identityKey.split(/\r?\n/).filter(line => line && !line.startsWith("-----"))] : [];
  const sensitiveValues = [
    ...identityValues,
    password,
    authHeader,
    bridge.secret,
    assignedMcp?.token,
    input.options.environment?.OPENROUTER_API_KEY,
    input.options.environment?.PAPERCLIP_AI_PROVIDER_KEY,
  ].filter((value): value is string => Boolean(value));
  input.trace?.addSensitiveValues(sensitiveValues);
  const instructionRoot =
    input.options.runtimeContext?.instructions.bundle.rootPath;
  // OpenCode canonicalizes tool paths (for example /var -> /private/var on
  // macOS). Permit the assigned workspace under either spelling; operations
  // within it still obey the selected allow/ask/deny permission mode.
  const externalDirectories: Record<string, string> = { "*": "deny" };
  for (const root of new Set([input.cwd, await realpath(input.cwd)])) {
    externalDirectories[root] = "allow";
    externalDirectories[`${root}/**`] = "allow";
  }
  if (instructionRoot) externalDirectories[`${instructionRoot}/**`] = "allow";
  const [modelProvider, ...modelIdParts] = input.options.model.split("/");
  const providerModelId = modelIdParts.join("/");
  const providerProxy = modelProvider === "paperclip" && input.options.environment?.PAPERCLIP_AI_PROVIDER_URL
    ? await startOpenCodeProviderProxy(input.options.environment.PAPERCLIP_AI_PROVIDER_URL, input.options.environment.PAPERCLIP_AI_PROVIDER_KEY ?? "", providerModelId, input.options.environment).catch(async error => {
        await bridge.close().catch(() => {});
        await rm(isolatedHome, { recursive: true, force: true }).catch(() => {});
        throw error;
      })
    : null;
  if (providerProxy) {
    sensitiveValues.push(providerProxy.token);
    input.trace?.addSensitiveValues([providerProxy.token]);
  }
  let child: ChildProcess | undefined;
  let launchPrepared = false;
  const releaseExecutable = () => {
    if (!launchPrepared) return;
    launchPrepared = false;
    try {
      input.options.commandLifecycle?.afterExit?.();
    } catch (error) {
      input.options.onDiagnostic?.(redact(`OpenCode executable cleanup failed: ${String(error)}`, sensitiveValues));
    }
  };
  const configPath = join(configHome, "opencode", "opencode.json");
  const configInput = {
    options: input.options,
    modelProvider: modelProvider!,
    providerModelId,
    providerProxy,
    externalDirectories,
    bridge,
    assignedMcp,
  } as const;
  try {
    // OpenCode V1 and V2 read the same config path but want different shapes.
    // V2 normalizes the V1 shape through its compatibility layer, so bootstrap
    // with V1 (which also keeps the V1 path byte-identical) and, once the server
    // reports V2, rewrite the native shape and reload the location.
    await writeOpenCodeConfig(
      configPath,
      buildOpenCodeConfig({ ...configInput, apiVersion: "v1" }),
    );
    const environment = sanitizedEnvironment(
      input.options.environment ?? process.env,
      {
        HOME: isolatedHome,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        // The runner pins the executable, model and assigned MCP tools. A
        // fresh isolated cache must not fetch a catalog or install unrelated
        // default plugins before it can submit the first prompt.
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
        ...(providerProxy ? { NO_PROXY: [input.options.environment?.no_proxy ?? input.options.environment?.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") } : {}),
      },
    );
    const isolateProcessGroup = input.options.isolateProcessGroup ?? true;
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "ignore", "pipe"];
    if (input.options.commandFd !== undefined) {
      while (stdio.length <= input.options.commandFd) stdio.push("ignore");
      stdio[input.options.commandFd] = input.options.commandFd;
    }
    input.options.commandLifecycle?.beforeSpawn();
    launchPrepared = true;
    child = spawn(
      input.options.command ?? resolvePinnedOpenCodeCommand(),
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: input.cwd,
        env: environment,
        stdio,
        detached: globalThis.process.platform !== "win32" && isolateProcessGroup,
      },
    );
    child.once("exit", releaseExecutable);
    if (child.pid !== undefined) {
      try {
        input.options.commandLifecycle?.afterSpawn();
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }
    }
    let diagnostics = "";
    child.stderr?.on("data", (chunk) => {
      const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const redactedDiagnostic = redact(raw.toString("utf8"), sensitiveValues);
      diagnostics = `${diagnostics}${redactedDiagnostic}`.slice(-8_192);
      const frameId = input.trace?.frame({
        direction: "provider_stderr",
        raw,
        transport: "process_stderr",
        nativeMethod: "opencode serve stderr",
      });
      if (frameId) {
        input.trace?.interpretation({
          frameId,
          stage: "typescript_opencode_process_transport",
          ruleId: "opencode.stderr",
          disposition: "operator_only",
          reason:
            "OpenCode stderr is retained only in the restricted trace sidecar",
        });
      }
      input.options.onDiagnostic?.(redactedDiagnostic);
    });
    const providerChild = child;
    await new Promise<void>((resolve, reject) => {
      providerChild.once("spawn", resolve);
      providerChild.once("error", reject);
    });
    if (child.pid)
      await input.options.onSpawn?.({
        pid: child.pid,
        processGroupId:
          globalThis.process.platform === "win32" || !isolateProcessGroup
            ? null
            : child.pid,
        startedAt: new Date().toISOString(),
      });
    const baseUrl = `http://127.0.0.1:${port}`;
    const fetcher = input.options.fetch ?? globalThis.fetch;
    const detected = await waitForServerInfo(
      baseUrl,
      authHeader,
      fetcher,
      child,
      () => diagnostics,
      input.trace,
    );
    const classified = classifyOpenCodeServerInfo({
      version: text(record(detected.value).version),
      apiVersion: detected.apiVersion,
    });
    if (!classified)
      throw new Error("OpenCode server-info response omitted a semantic version");
    const { version, apiVersion } = classified;
    if (
      !isQualifiedOpenCodeVersion(version) &&
      !allowsUnqualifiedOpenCodeRunnerVersion(
        input.options.environment ?? process.env,
      )
    ) {
      throw new Error(unqualifiedOpenCodeVersionMessage(version));
    }
    const apiContext: OpenCodeApiContext = {
      baseUrl,
      authHeader,
      trace: input.trace,
      sensitiveValues,
    };
    const protocolVersion = protocolVersionForApiVersion(apiVersion);
    const client = createOpenCodeApiClient({
      apiVersion,
      transport: {
        request: (path, init) => api(fetcher, apiContext, path, init),
      },
      directory: input.cwd,
    });
    if (apiVersion === "v2") {
      // Apply the native V2 shape now that the server version is known.
      await writeOpenCodeConfig(
        configPath,
        buildOpenCodeConfig({ ...configInput, apiVersion: "v2" }),
      );
      let reloadError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await api(fetcher, apiContext, "/api/location/reload", {
            method: "POST",
            body: JSON.stringify({}),
          });
          reloadError = null;
          break;
        } catch (error) {
          reloadError = error;
          if (attempt < 3)
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      if (reloadError) {
        // Continuing with the bootstrap config would start a session that has no
        // `paperclip` agent and no MCP servers, and the V2 prompt discards the
        // system prompt, so the runner could not supply its instructions on
        // either path. Fail startup instead of running a hollow session.
        throw new Error(
          `OpenCode V2 rejected the runtime config reload after 3 attempts, so the required agent instructions and MCP servers would be unavailable. ${redact(String(reloadError), sensitiveValues)}`,
        );
      }
      // V2 does not auto-connect MCP servers, and registration after a reload
      // is asynchronous. Nudge each server with an explicit connect, then wait
      // for the Paperclip servers to report connected so the first session
      // exposes the semantic tools to the model.
      const expectedMcp = [
        "paperclip",
        ...(assignedMcp ? [assignedMcp.name] : []),
      ];
      const connectMcp = async (names: Iterable<string>) => {
        for (const name of names) {
          try {
            await api(
              fetcher,
              apiContext,
              `/api/experimental/mcp/${encodeURIComponent(name)}/connect`,
              { method: "POST", body: JSON.stringify({}) },
            );
          } catch {
            /* the connect endpoint is best-effort; the poll below is authoritative */
          }
        }
      };
      await connectMcp(expectedMcp);
      const mcpDeadline = Date.now() + 10_000;
      const pendingMcp = new Set(expectedMcp);
      let lastConnectAt = Date.now();
      while (pendingMcp.size > 0 && Date.now() < mcpDeadline) {
        try {
          const listing = record(
            await api(fetcher, apiContext, "/api/mcp"),
          );
          const statuses = new Map(
            arrayOfRecords(listing.data).map((server) => [
              text(server.name),
              text(record(server.status).status),
            ]),
          );
          for (const name of [...pendingMcp]) {
            if (statuses.get(name) === "connected") pendingMcp.delete(name);
          }
        } catch {
          /* the location is still reloading */
        }
        if (pendingMcp.size > 0) {
          // Registration after a reload is asynchronous, so the first connect
          // can arrive before the server exists. Re-issue it while we wait.
          if (Date.now() - lastConnectAt >= 1_000) {
            lastConnectAt = Date.now();
            await connectMcp([...pendingMcp]);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (pendingMcp.size > 0) {
        // A retry can complete after the loop deadline but within the request
        // timeout, so re-read the status once more before failing startup.
        try {
          const listing = record(await api(fetcher, apiContext, "/api/mcp"));
          const statuses = new Map(
            arrayOfRecords(listing.data).map((server) => [
              text(server.name),
              text(record(server.status).status),
            ]),
          );
          for (const name of [...pendingMcp]) {
            if (statuses.get(name) === "connected") pendingMcp.delete(name);
          }
        } catch {
          /* fall through to the failure below */
        }
      }
      if (pendingMcp.size > 0) {
        // Without the loop, the model never sees the semantic tools, the
        // completion tool fails, and the turn ends with no structured result.
        throw new Error(
          `OpenCode V2 MCP servers did not report connected before the session started: ${[...pendingMcp].join(", ")}. The agent would run without the Paperclip completion and assigned tools.`,
        );
      }
    }
    return {
      baseUrl,
      authHeader,
      version,
      apiVersion,
      protocolVersion,
      client,
      permissionMode: input.options.permissionMode ?? "allow",
      process: child,
      bridge,
      trace: input.trace,
      sensitiveValues,
      close: async (closeInput = {}) => {
        await providerProxy?.close();
        await bridge.close().catch(() => {});
        if (providerChild.exitCode === null && providerChild.signalCode === null && providerChild.pid) {
          try {
            if (globalThis.process.platform === "win32" || !isolateProcessGroup)
              providerChild.kill("SIGTERM");
            else globalThis.process.kill(-providerChild.pid, "SIGTERM");
          } catch {
            providerChild.kill("SIGTERM");
          }
        }
        await waitForExit(providerChild, 2_000);
        if (providerChild.exitCode === null && providerChild.signalCode === null && providerChild.pid) {
          try {
            if (globalThis.process.platform === "win32" || !isolateProcessGroup)
              providerChild.kill("SIGKILL");
            else globalThis.process.kill(-providerChild.pid, "SIGKILL");
          } catch {
            providerChild.kill("SIGKILL");
          }
          await waitForExit(providerChild, 2_000);
        }
        await rm(join(configHome, "opencode", "opencode.json"), {
          force: true,
        }).catch(() => undefined);
        await rm(isolatedHome, { recursive: true, force: true }).catch(
          () => undefined,
        );
        if (closeInput.finalizeTrace !== false) {
          await input.trace?.finish({ reason: closeInput.reason ?? null });
        }
      },
    };
  } catch (error) {
    await providerProxy?.close();
    await bridge.close().catch(() => {});
    child?.kill("SIGKILL");
    if (child?.pid) await waitForExit(child, 2_000);
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) releaseExecutable();
    await rm(join(configHome, "opencode", "opencode.json"), {
      force: true,
    }).catch(() => undefined);
    await rm(isolatedHome, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

export function normalizeOpenCodeQuestionSet(
  nativeQuestions: Record<string, unknown>[],
  metadata: Record<string, unknown> = {},
): PaperclipQuestionSet {
  const questions = nativeQuestions.map(
    (question, index): PaperclipQuestion => {
      const options = (Array.isArray(question.options) ? question.options : [])
        .map(record)
        .slice(0, 128)
        .map((option, optionIndex) => ({
          id: text(option.id, `option-${optionIndex + 1}`).slice(0, 160),
          label: text(
            option.label,
            text(option.value, `Option ${optionIndex + 1}`),
          ).slice(0, 1_000),
          ...(text(option.description)
            ? { description: text(option.description).slice(0, 4_000) }
            : {}),
        }));
      return {
        id: openCodeQuestionId(question, index),
        ...(text(question.header)
          ? { header: text(question.header).slice(0, 1_000) }
          : {}),
        prompt: text(
          question.question,
          text(question.prompt, `Question ${index + 1}`),
        ).slice(0, 4_000),
        ...(text(question.description)
          ? { helpText: text(question.description).slice(0, 4_000) }
          : {}),
        required: question.required === true,
        answerMode:
          options.length === 0
            ? "text"
            : question.multiple === true
              ? "multi_select"
              : "single_select",
        ...(options.length > 0 ? { options } : {}),
        ...(question.custom === true || question.allowCustom === true
          ? {
              customAnswer: {
                enabled: true,
                label: "Other",
                placeholder: "Enter another answer",
              },
            }
          : {}),
      };
    },
  );
  return parsePaperclipQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title: text(metadata.title, "OpenCode needs your input").slice(0, 1_000),
    ...(text(metadata.description)
      ? { description: text(metadata.description).slice(0, 4_000) }
      : {}),
    submitLabel: text(metadata.submitLabel, "Submit answers").slice(0, 200),
    questions,
  });
}

function openCodeAnswers(
  pending: {
    request: HarnessRuntimeRequest;
    nativeQuestions: Record<string, unknown>[];
  },
  response: PaperclipQuestionResponse,
): string[][] {
  return pending.nativeQuestions.map((nativeQuestion, index) => {
    const questionId = openCodeQuestionId(nativeQuestion, index);
    const question = pending.request.input?.questions.find(
      (candidate) => candidate.id === questionId,
    );
    const answer = response.answers[questionId];
    if (!question || !answer) return [];
    const values = (answer.selectedOptionIds ?? [])
      .map(
        (optionId) =>
          question.options?.find((option) => option.id === optionId)?.label,
      )
      .filter((value): value is string => typeof value === "string");
    if (answer.text !== undefined) values.push(answer.text);
    if (answer.customText !== undefined) values.push(answer.customText);
    return values;
  });
}

async function api(
  fetcher: typeof globalThis.fetch,
  runtime: OpenCodeApiContext,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  const method = String(init.method ?? "GET").toUpperCase();
  const requestRaw =
    typeof init.body === "string"
      ? init.body
      : init.body instanceof Uint8Array
        ? init.body
        : "";
  const requestFrameId = runtime.trace?.frame({
    direction: "client_to_provider",
    raw: requestRaw,
    transport: "http_json",
    nativeMethod: `${method} ${path}`,
  });
  if (requestFrameId) {
    runtime.trace?.interpretation({
      frameId: requestFrameId,
      stage: "typescript_opencode_http_transport",
      ruleId: `opencode.http.${method}.${safeTraceRulePath(path)}`,
      disposition: "operator_only",
      reason: "Sent an exact HTTP request body to the OpenCode app server",
    });
  }
  let response: Response;
  try {
    response = await fetcher(`${runtime.baseUrl}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: runtime.authHeader,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new Error(
      `OpenCode API ${path} request failed: ${redact(String(error), runtime.sensitiveValues)}`,
    );
  }
  const responseRaw = await response.text();
  const responseFrameId = runtime.trace?.frame({
    direction: "provider_to_client",
    raw: responseRaw,
    transport: "http_json",
    nativeMethod: `${method} ${path} ${response.status}`,
  });
  if (!response.ok) {
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: `opencode.http.error.${response.status}`,
        disposition: "rejected",
        reason: `OpenCode API returned HTTP ${response.status}`,
      });
    }
    throw new Error(
      `OpenCode API ${path} returned HTTP ${response.status}: ${redact(responseRaw, runtime.sensitiveValues)}`,
    );
  }
  if (response.status === 204 || !responseRaw) {
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: "opencode.http.empty_success",
        disposition: "operator_only",
        reason: "OpenCode API returned a successful empty response",
      });
    }
    return null;
  }
  try {
    const parsed = JSON.parse(responseRaw) as unknown;
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: "opencode.http.json_success",
        disposition: "operator_only",
        fieldMappings: [
          {
            inputPath: "$raw",
            outputPath: "$response",
            action: "normalized",
            reason: "Decoded the exact OpenCode HTTP response body as JSON",
          },
        ],
        reason: "OpenCode HTTP response parsed as JSON",
      });
    }
    return parsed;
  } catch (error) {
    if (responseFrameId) {
      runtime.trace?.interpretation({
        frameId: responseFrameId,
        stage: "typescript_opencode_http_parse",
        ruleId: "opencode.http.invalid_json",
        disposition: "rejected",
        reason: `OpenCode response was not valid JSON: ${String(error).slice(0, 400)}`,
      });
    }
    throw error;
  }
}

function retryableOpenCodeStartupError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("request failed") ||
    message.includes("did not become healthy") ||
    message.includes("exited during startup") ||
    message.includes("provider_initialize_timeout") ||
    message.includes("provider_process_exited") ||
    message.includes("HTTP 408") ||
    message.includes("HTTP 425") ||
    message.includes("HTTP 429") ||
    /HTTP 5\d\d/.test(message)
  );
}

async function waitForServerInfo(
  baseUrl: string,
  authHeader: string,
  fetcher: typeof globalThis.fetch,
  process: ChildProcess,
  diagnostics: () => string,
  trace: ProviderTraceFileSink | null,
): Promise<{ value: unknown; apiVersion: OpenCodeApiVersion }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) {
      const detail = redact(diagnostics());
      throw new Error(
        `provider_process_exited: provider=opencode stage=health exitCode=${process.exitCode ?? "null"} signal=${process.signalCode ?? "null"}${detail ? ` stderrTail=${detail}` : ""}`,
      );
    }
    // V2 answers `/api/info`; V1 answers `/global/health`. Probe V2 first so a
    // single server is identified without a version preflight.
    for (const probe of [
      { path: "/api/info", apiVersion: "v2" as const, ruleId: "opencode.http.GET_api_info" },
      { path: "/global/health", apiVersion: "v1" as const, ruleId: "opencode.http.GET_global_health" },
    ]) {
      try {
        const requestFrameId = trace?.frame({
          direction: "client_to_provider",
          raw: "",
          transport: "http_json",
          nativeMethod: `GET ${probe.path}`,
        });
        if (requestFrameId) {
          trace?.interpretation({
            frameId: requestFrameId,
            stage: "typescript_opencode_http_transport",
            ruleId: probe.ruleId,
            disposition: "operator_only",
            reason: "Probed the local OpenCode app-server info endpoint",
          });
        }
        const response = await fetcher(`${baseUrl}${probe.path}`, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(1_000),
        });
        const raw = await response.text();
        const responseFrameId = trace?.frame({
          direction: "provider_to_client",
          raw,
          transport: "http_json",
          nativeMethod: `GET ${probe.path} ${response.status}`,
        });
        if (!response.ok) continue;
        const parsed = JSON.parse(raw) as unknown;
        if (responseFrameId) {
          trace?.interpretation({
            frameId: responseFrameId,
            stage: "typescript_opencode_http_parse",
            ruleId: "opencode.http.health_success",
            disposition: "operator_only",
            reason: "OpenCode server-info response parsed successfully",
          });
        }
        return { value: parsed, apiVersion: probe.apiVersion };
      } catch {
        /* server is still starting */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = redact(diagnostics());
  throw new Error(
    `provider_initialize_timeout: provider=opencode stage=health${detail ? ` stderrTail=${detail}` : ""}`,
  );
}

async function writeOpenCodeConfig(
  path: string,
  config: Record<string, unknown>,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

function buildOpenCodeConfig(input: {
  apiVersion: OpenCodeApiVersion;
  options: OpenCodeServerDriverOptions;
  modelProvider: string;
  providerModelId: string;
  providerProxy: { baseURL: string; token: string } | null;
  externalDirectories: Record<string, string>;
  bridge: OpenCodeMcpBridge;
  assignedMcp: ReturnType<typeof nativeMcpLaunchBinding>;
}): Record<string, unknown> {
  const permissionMode = input.options.permissionMode ?? "allow";
  const systemInstructions =
    input.options.systemInstructions ?? CODEX_SKILLLESS_BASE_INSTRUCTIONS;
  if (input.apiVersion === "v2") {
    const externalRules = Object.entries(input.externalDirectories)
      .filter(([resource]) => resource !== "*")
      .map(([resource, effect]) => ({
        action: "external_directory",
        resource,
        effect,
      }));
    return {
      $schema: "https://opencode.ai/config.json",
      model: input.options.model,
      agents: {
        [OPEN_CODE_RUNNER_AGENT]: { system: systemInstructions },
        title: { model: input.options.model },
      },
      share: "disabled",
      // The configured entry is already composed exactly once into the session
      // system prompt; siblings remain available through the read-only root.
      instructions: [],
      plugins: [],
      // OpenCode's bundled models.dev snapshot can lag behind OpenRouter's live
      // catalog. Bind the already-qualified exact model slug into the built-in
      // provider instead of silently falling back or rejecting a newer model.
      providers: {
        [input.modelProvider]: {
          ...(input.providerProxy
            ? {
                package: "aisdk:@ai-sdk/openai-compatible",
                name: "Paperclip connection",
                settings: {
                  baseURL: input.providerProxy.baseURL,
                  apiKey: input.providerProxy.token,
                },
              }
            : {}),
          models: {
            [input.providerModelId]: { name: input.providerModelId },
          },
        },
      },
      // V2 uses one ordered rule list; the last match wins. Mirror the V1
      // permission map: broad policy first, then the Paperclip and directory
      // exceptions.
      permissions: [
        { action: "*", resource: "*", effect: permissionMode },
        { action: "question", resource: "*", effect: "allow" },
        { action: "paperclip_*", resource: "*", effect: "allow" },
        { action: "mcp__paperclip__*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "deny" },
        ...externalRules,
      ],
      mcp: {
        servers: {
          paperclip: openCodeV2McpServer(input.bridge.url, input.bridge.secret),
          ...(input.assignedMcp
            ? {
                [input.assignedMcp.name]: openCodeV2McpServer(
                  input.assignedMcp.url,
                  input.assignedMcp.token,
                ),
              }
            : {}),
        },
      },
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    model: input.options.model,
    small_model: input.options.model,
    share: "disabled",
    autoupdate: false,
    instructions: [],
    plugin: [],
    provider: {
      [input.modelProvider]: {
        ...(input.providerProxy
          ? {
              npm: "@ai-sdk/openai-compatible",
              name: "Paperclip connection",
              options: {
                baseURL: input.providerProxy.baseURL,
                apiKey: input.providerProxy.token,
              },
            }
          : {}),
        models: {
          [input.providerModelId]: {
            name: input.providerModelId,
            ...(input.modelProvider === "openrouter"
              ? { variants: {
                  "paperclip-default": {},
                  "paperclip-no-reasoning": { reasoning: { enabled: false } },
                } }
              : {}),
          },
        },
      },
    },
    tools: {
      question: true,
    },
    permission: {
      "*": permissionMode,
      question: "allow",
      "paperclip_*": "allow",
      "mcp__paperclip__*": "allow",
      external_directory: input.externalDirectories,
    },
    mcp: {
      paperclip: {
        type: "remote",
        url: input.bridge.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${input.bridge.secret}` },
        timeout: 30_000,
      },
      ...(input.assignedMcp
        ? {
            [input.assignedMcp.name]: {
              type: "remote",
              url: input.assignedMcp.url,
              enabled: true,
              oauth: false,
              headers: { Authorization: `Bearer ${input.assignedMcp.token}` },
              timeout: 30_000,
            },
          }
        : {}),
    },
  };
}

function openCodeV2McpServer(
  url: string,
  secret: string,
): Record<string, unknown> {
  return {
    type: "remote",
    url,
    disabled: false,
    oauth: false,
    // V2 Code Mode would group the Paperclip tools behind a code-execution
    // tool. The runner contract requires the model to call the semantic tools
    // directly, so keep them on the provider's native tool list.
    codemode: false,
    headers: { Authorization: `Bearer ${secret}` },
    timeout: { catalog: 30_000, execution: 30_000 },
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to reserve OpenCode port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function* parseSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ raw: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1_048_576)
      throw new Error("OpenCode SSE event exceeded the retained payload limit");
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const rawFrame = buffer.slice(0, boundary.index);
      const raw = buffer.slice(0, boundary.index + boundary[0].length);
      const frame = rawFrame.replaceAll("\r", "");
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      yield { raw, data };
    }
  }
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<unknown> {
  for await (const frame of parseSseFrames(stream))
    yield JSON.parse(frame.data);
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const allowed = [
    "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENROUTER_API_KEY",
    "OPENCODE_ALLOW_ALL_MODELS",
    // Test harness signal that selects the fake server's protocol generation.
    "FAKE_OPENCODE_API",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed)
    if (source[key] !== undefined) result[key] = source[key];
  return { ...result, ...overrides };
}

function sanitizedEnvironmentKeys(): string[] {
  return [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENROUTER_API_KEY",
    "OPENCODE_ALLOW_ALL_MODELS",
    // Test harness signal that selects the fake server's protocol generation.
    "FAKE_OPENCODE_API",
  ];
}

function sessionRoot(
  runtimeDirectory: string,
  normalizedSessionId: string,
): string {
  const safe = normalizedSessionId
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  if (!safe || safe === "." || safe === "..")
    throw new Error("Invalid normalized OpenCode session id");
  return join(resolve(runtimeDirectory), safe);
}

function validateWorkspace(value: string): string {
  const cwd = resolve(value);
  if (!value.trim() || cwd === dirname(cwd))
    throw new Error("OpenCode working directory must not be a filesystem root");
  return cwd;
}

function validModel(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

function bounded(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 64 * 1024)
    return { omitted: true, reason: "payload_limit" };
  const parsed = JSON.parse(serialized) as unknown;
  return isRecord(parsed) ? parsed : { value: parsed };
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function hasPositiveNumber(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (Array.isArray(value)) return value.some(hasPositiveNumber);
  if (isRecord(value)) return Object.values(value).some(hasPositiveNumber);
  return false;
}
function safeTraceRulePath(value: string): string {
  return value
    .replace(/\/[A-Za-z0-9_-]{12,}/g, "/:id")
    .replace(/[^A-Za-z0-9_.:/-]/g, "_")
    .replaceAll("/", "_")
    .slice(0, 120);
}
function redact(
  value: string,
  sensitiveValues: readonly (string | undefined)[] = [],
): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive && sensitive.length >= 4)
      redacted = redacted.split(sensitive).join("[REDACTED]");
  }
  return redacted
    .replace(
      /(OPENROUTER_API_KEY|authorization|password|token|secret)\s*[:=]\s*[^\s,}\]]+/gi,
      "$1=[REDACTED]",
    )
    .slice(0, 8_192);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

async function waitForExit(
  process: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export const openCodeServerDriverInternals = { parseSse };

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown = null;
  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0))
      waiter.resolve({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined)
          return Promise.resolve({ done: false, value: item });
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) =>
          this.#waiters.push({ resolve, reject }),
        );
      },
    };
  }
}

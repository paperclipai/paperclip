import { randomUUID } from "node:crypto";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
} from "../drivers/codex/app-server-transport.js";
import { redactCodexDiagnostic } from "../drivers/codex/app-server-transport.js";
import { createSkilllessCodexThreadConfig } from "../drivers/codex/codex-app-server-driver.js";
import type {
  Phase7FixtureInteraction,
  Phase7FixtureSeed,
  Phase7FixtureState,
  Phase7InteractionKind,
  Phase7JsonValue,
  Phase7OpenFixtureRunInput,
} from "../mock-core/phase7-control-plane-types.js";
import { Phase7MockControlPlaneAdapter } from "../mock-core/phase7-mock-control-plane-adapter.js";
import { Phase7SemanticDispatcher } from "../semantic-tools/dispatcher.js";
import type {
  Phase7SemanticAuthorizationRecord,
  Phase7SemanticScenarioPolicy,
  Phase7SemanticToolDefinition,
  Phase7SemanticToolResult,
} from "../semantic-tools/types.js";
import {
  createPhase7RunnerdCodexTransport,
  type Phase7RunnerdCodexTransport,
  type Phase7RunnerdCodexTransportOptions,
  type Phase7RunnerdProcessEvidence,
} from "./runnerd-codex-transport.js";

const LIVE_SESSION_SCHEMA = "paperclip.phase7.live-session.v1" as const;
const LIVE_BASE_INSTRUCTIONS = [
  "You are operating one mock Paperclip issue through typed semantic tools.",
  "Use only the tools exposed in this thread; never call a Paperclip REST API.",
  "Treat every tool result as authoritative mock state and use it in your next response.",
  "The user conversation and provider are real, but all Paperclip records are mock records.",
  "Do not discover skills, credentials, endpoints, or hidden control-plane capabilities.",
].join(" ");
const CODEX_PERMISSION_PROFILE = "paperclip-runner-workspace-only";

export type Phase7LiveSessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "stopping"
  | "closed"
  | "failed";

export interface Phase7LiveTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  at: string;
}

export interface Phase7LiveEvidenceEntry {
  id: string;
  kind:
    | "session"
    | "provider_event"
    | "tool_exposure"
    | "tool_call"
    | "tool_result"
    | "interaction"
    | "process"
    | "diagnostic"
    | "cleanup";
  at: string;
  turnId: string | null;
  data: Record<string, Phase7JsonValue>;
}

export interface Phase7LiveAuthoritySnapshot {
  active: boolean;
  runId: string;
  companyId: string;
  actorId: string;
  taskId: string;
  sessionId: string;
  scenarioId: string;
  capabilities: string[];
  explicitClaims: string[];
}

export interface Phase7LiveSessionConfigSnapshot {
  workingDirectory: string;
  scenario: Phase7SemanticScenarioPolicy;
  capabilities: string[];
  explicitClaims: string[];
  seedState: string;
  turnTimeoutMs: number;
}

export interface Phase7LiveSessionSnapshot {
  schema: typeof LIVE_SESSION_SCHEMA;
  revision: number;
  sessionId: string;
  providerThreadId: string;
  providerSessionId: string | null;
  status: Phase7LiveSessionStatus;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  authority: Phase7LiveAuthoritySnapshot;
  config: Phase7LiveSessionConfigSnapshot;
  mockState: string;
  transcript: Phase7LiveTranscriptEntry[];
  evidence: Phase7LiveEvidenceEntry[];
  authorizationRecords: Phase7SemanticAuthorizationRecord[];
  process: Phase7RunnerdProcessEvidence | null;
  networkEvidence: {
    realPaperclipRequests: 0;
    childPaperclipEnvironmentKeys: string[];
  };
}

export interface CreatePhase7LiveSessionInput {
  seed?: Phase7FixtureSeed | Phase7FixtureState;
  workingDirectory?: string;
  scenario?: Phase7SemanticScenarioPolicy;
  capabilities?: string[];
  explicitClaims?: string[];
  companyId?: string;
  actorId?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  turnTimeoutMs?: number;
}

export interface Phase7LiveTurnResult {
  turnId: string;
  status: "completed" | "failed" | "interrupted" | "cancelled";
  assistantText: string;
  snapshot: Phase7LiveSessionSnapshot;
}

export interface Phase7InteractionResolution {
  interactionId: string;
  outcome: "answered" | "accepted" | "rejected" | "expired";
  result: Phase7JsonValue;
}

export interface Phase7LiveSessionStore {
  load(sessionId: string): Promise<Phase7LiveSessionSnapshot | null>;
  save(snapshot: Phase7LiveSessionSnapshot): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export class InMemoryPhase7LiveSessionStore implements Phase7LiveSessionStore {
  readonly #snapshots = new Map<string, Phase7LiveSessionSnapshot>();

  async load(sessionId: string): Promise<Phase7LiveSessionSnapshot | null> {
    const snapshot = this.#snapshots.get(sessionId);
    return snapshot === undefined ? null : structuredClone(snapshot);
  }

  async save(snapshot: Phase7LiveSessionSnapshot): Promise<void> {
    this.#snapshots.set(snapshot.sessionId, structuredClone(snapshot));
  }

  async delete(sessionId: string): Promise<void> {
    this.#snapshots.delete(sessionId);
  }
}

export type Phase7LiveTransportFactory = (
  options: Phase7RunnerdCodexTransportOptions,
) => Phase7RunnerdCodexTransport;

export interface Phase7LiveSessionServiceOptions {
  store?: Phase7LiveSessionStore;
  transportFactory?: Phase7LiveTransportFactory;
  transportOptions?: Phase7RunnerdCodexTransportOptions;
  now?: () => Date;
}

interface TurnWaiter {
  resolve: (result: Omit<Phase7LiveTurnResult, "snapshot">) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  assistantText: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function jsonValue(value: unknown): Phase7JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Phase7JsonValue;
}

function dynamicToolSpec(definition: Phase7SemanticToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

function userInput(message: string): Record<string, unknown> {
  return { type: "text", text: message, text_elements: [] };
}

function terminalStatus(value: unknown): Phase7LiveTurnResult["status"] {
  const status = text(value, "completed");
  return status === "failed" || status === "interrupted" || status === "cancelled"
    ? status
    : "completed";
}

function pendingInteractions(port: Phase7MockControlPlaneAdapter): Phase7FixtureInteraction[] {
  return port.snapshot().interactions.filter((interaction) => interaction.status === "pending");
}

export class Phase7LiveSessionService {
  readonly #store: Phase7LiveSessionStore;
  readonly #transportFactory: Phase7LiveTransportFactory;
  readonly #transportOptions: Phase7RunnerdCodexTransportOptions;
  readonly #now: () => Date;
  readonly #sessions = new Map<string, Phase7LiveSession>();

  constructor(options: Phase7LiveSessionServiceOptions = {}) {
    this.#store = options.store ?? new InMemoryPhase7LiveSessionStore();
    this.#transportFactory = options.transportFactory ?? createPhase7RunnerdCodexTransport;
    this.#transportOptions = options.transportOptions ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreatePhase7LiveSessionInput = {}): Promise<Phase7LiveSession> {
    const port = new Phase7MockControlPlaneAdapter(input.seed);
    const seedState = port.serialize();
    await port.start();
    const state = port.snapshot();
    const sessionId = input.sessionId ?? randomUUID();
    const runId = input.runId ?? randomUUID();
    const capabilities = [...(input.capabilities ?? [])];
    const scenario = input.scenario ?? { id: "phase7-live-default" };
    const authority: Phase7LiveAuthoritySnapshot = {
      active: true,
      runId,
      companyId: input.companyId ?? state.company.id,
      actorId: input.actorId ?? state.actors[0]!.id,
      taskId: input.taskId ?? state.tasks[0]!.id,
      sessionId,
      scenarioId: scenario.id,
      capabilities,
      explicitClaims: [...(input.explicitClaims ?? capabilities)],
    };
    await port.openFixtureRun({
      identity: {
        runId,
        sessionId,
        companyId: authority.companyId,
        issueId: authority.taskId,
        agentId: authority.actorId,
      },
      backendKind: "runner",
      sourceInstanceId: "phase7-live-runnerd",
      capabilities,
    });
    const session = await Phase7LiveSession.open({
      port,
      authority,
      config: {
        workingDirectory: input.workingDirectory ?? process.cwd(),
        scenario,
        capabilities,
        explicitClaims: authority.explicitClaims,
        seedState,
        turnTimeoutMs: input.turnTimeoutMs ?? 120_000,
      },
      store: this.#store,
      transportFactory: this.#transportFactory,
      transportOptions: this.#transportOptions,
      now: this.#now,
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  async restore(sessionId: string): Promise<Phase7LiveSession> {
    const live = this.#sessions.get(sessionId);
    if (live !== undefined) return live;
    const snapshot = await this.#store.load(sessionId);
    if (snapshot === null) throw new Error(`phase7 live session ${sessionId} was not found`);
    const session = await Phase7LiveSession.restore({
      snapshot,
      store: this.#store,
      transportFactory: this.#transportFactory,
      transportOptions: this.#transportOptions,
      now: this.#now,
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  async reconnect(sessionId: string): Promise<Phase7LiveSessionSnapshot> {
    const session = await this.restore(sessionId);
    await session.reconnect();
    return session.snapshot();
  }

  async reset(sessionId: string): Promise<Phase7LiveSession> {
    const session = await this.restore(sessionId);
    const config = session.snapshot().config;
    await session.shutdown("reset");
    this.#sessions.delete(sessionId);
    await this.#store.delete(sessionId);
    const seedPort = Phase7MockControlPlaneAdapter.restore(config.seedState);
    return this.create({
      seed: seedPort.snapshot(),
      workingDirectory: config.workingDirectory,
      scenario: config.scenario,
      capabilities: config.capabilities,
      explicitClaims: config.explicitClaims,
      turnTimeoutMs: config.turnTimeoutMs,
    });
  }

  async stop(sessionId: string, reason = "operator stopped session"): Promise<Phase7LiveSessionSnapshot> {
    const session = await this.restore(sessionId);
    await session.shutdown(reason);
    this.#sessions.delete(sessionId);
    return session.snapshot();
  }

  async shutdown(sessionId: string, reason = "service shutdown"): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    await session.shutdown(reason);
    this.#sessions.delete(sessionId);
  }
}

interface OpenSessionOptions {
  port: Phase7MockControlPlaneAdapter;
  authority: Phase7LiveAuthoritySnapshot;
  config: Phase7LiveSessionConfigSnapshot;
  store: Phase7LiveSessionStore;
  transportFactory: Phase7LiveTransportFactory;
  transportOptions: Phase7RunnerdCodexTransportOptions;
  now: () => Date;
}

interface RestoreSessionOptions extends Omit<OpenSessionOptions, "port" | "authority" | "config"> {
  snapshot: Phase7LiveSessionSnapshot;
}

export class Phase7LiveSession {
  readonly #port: Phase7MockControlPlaneAdapter;
  readonly #dispatcher: Phase7SemanticDispatcher;
  readonly #store: Phase7LiveSessionStore;
  readonly #transportFactory: Phase7LiveTransportFactory;
  readonly #transportOptions: Phase7RunnerdCodexTransportOptions;
  readonly #now: () => Date;
  readonly #authority: Phase7LiveAuthoritySnapshot;
  readonly #config: Phase7LiveSessionConfigSnapshot;
  readonly #createdAt: string;
  readonly #transcript: Phase7LiveTranscriptEntry[];
  readonly #evidence: Phase7LiveEvidenceEntry[];
  readonly #priorAuthorizationRecords: Phase7SemanticAuthorizationRecord[];
  #transport: CodexAppServerTransport | null = null;
  #processEvidence: Phase7RunnerdProcessEvidence | null = null;
  #providerThreadId = "";
  #providerSessionId: string | null = null;
  #status: Phase7LiveSessionStatus = "starting";
  #activeTurnId: string | null = null;
  #revision = 0;
  #updatedAt: string;
  #entryCounter = 0;
  #turnWaiter: TurnWaiter | null = null;
  #pump: Promise<void> | null = null;
  #persistChain: Promise<void> = Promise.resolve();

  private constructor(options: OpenSessionOptions & { snapshot?: Phase7LiveSessionSnapshot }) {
    this.#port = options.port;
    this.#authority = structuredClone(options.authority);
    this.#config = structuredClone(options.config);
    this.#store = options.store;
    this.#transportFactory = options.transportFactory;
    this.#transportOptions = options.transportOptions;
    this.#now = options.now;
    this.#dispatcher = new Phase7SemanticDispatcher(this.#port, {
      scenario: this.#config.scenario,
      explicitClaims: this.#config.explicitClaims,
    });
    this.#createdAt = options.snapshot?.createdAt ?? this.#now().toISOString();
    this.#updatedAt = options.snapshot?.updatedAt ?? this.#createdAt;
    this.#transcript = structuredClone(options.snapshot?.transcript ?? []);
    this.#evidence = structuredClone(options.snapshot?.evidence ?? []);
    this.#priorAuthorizationRecords = structuredClone(options.snapshot?.authorizationRecords ?? []);
    this.#providerThreadId = options.snapshot?.providerThreadId ?? "";
    this.#providerSessionId = options.snapshot?.providerSessionId ?? null;
    this.#activeTurnId = options.snapshot?.activeTurnId ?? null;
    this.#revision = options.snapshot?.revision ?? 0;
    this.#entryCounter = this.#transcript.length + this.#evidence.length;
  }

  static async open(options: OpenSessionOptions): Promise<Phase7LiveSession> {
    const session = new Phase7LiveSession(options);
    await session.#connect(false);
    return session;
  }

  static async restore(options: RestoreSessionOptions): Promise<Phase7LiveSession> {
    if (options.snapshot.schema !== LIVE_SESSION_SCHEMA) {
      throw new Error("unsupported Phase 7 live session snapshot");
    }
    if (!options.snapshot.authority.active) {
      throw new Error("phase7 session authority was cleared and cannot be resumed");
    }
    const port = Phase7MockControlPlaneAdapter.restore(options.snapshot.mockState);
    if (port.snapshot().lifecycle !== "running") await port.start();
    const session = new Phase7LiveSession({
      ...options,
      port,
      authority: options.snapshot.authority,
      config: options.snapshot.config,
      snapshot: options.snapshot,
    });
    await session.#connect(true);
    return session;
  }

  get id(): string {
    return this.#authority.sessionId;
  }

  mockState() {
    return this.#port.snapshot();
  }

  pendingInteractions(): Phase7FixtureInteraction[] {
    return structuredClone(pendingInteractions(this.#port));
  }

  snapshot(): Phase7LiveSessionSnapshot {
    const records = [
      ...this.#priorAuthorizationRecords,
      ...this.#dispatcher.authorizationRecords(),
    ];
    const childKeys = this.#processEvidence?.childEnvironmentKeys ?? [];
    return {
      schema: LIVE_SESSION_SCHEMA,
      revision: this.#revision,
      sessionId: this.id,
      providerThreadId: this.#providerThreadId,
      providerSessionId: this.#providerSessionId,
      status: this.#status,
      activeTurnId: this.#activeTurnId,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      authority: structuredClone(this.#authority),
      config: structuredClone(this.#config),
      mockState: this.#port.serialize(),
      transcript: structuredClone(this.#transcript),
      evidence: structuredClone(this.#evidence),
      authorizationRecords: structuredClone(records),
      process: this.#processEvidence === null ? null : structuredClone(this.#processEvidence),
      networkEvidence: {
        realPaperclipRequests: 0,
        childPaperclipEnvironmentKeys: childKeys.filter((key) => key.startsWith("PAPERCLIP_")),
      },
    };
  }

  async sendMessage(message: string): Promise<Phase7LiveTurnResult> {
    const value = message.trim();
    if (value.length === 0) throw new Error("Phase 7 live messages cannot be empty");
    if (this.#transport === null || this.#status === "closed" || this.#status === "failed") {
      throw new Error("Phase 7 live session is not connected");
    }
    if (this.#activeTurnId !== null || this.#turnWaiter !== null) {
      throw new Error("Phase 7 live session already has an active turn");
    }
    this.#status = "running";
    this.#appendTranscript("user", value, null);
    let response: Record<string, unknown>;
    const terminal = new Promise<Omit<Phase7LiveTurnResult, "snapshot">>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#turnWaiter = null;
        reject(new Error(`Phase 7 Codex turn timed out after ${this.#config.turnTimeoutMs}ms`));
      }, this.#config.turnTimeoutMs);
      this.#turnWaiter = { resolve, reject, timer, assistantText: "" };
    });
    try {
      response = await this.#transport.request("turn/start", {
        threadId: this.#providerThreadId,
        cwd: this.#config.workingDirectory,
        permissions: CODEX_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#config.workingDirectory],
        input: [userInput(value)],
      });
    } catch (error) {
      this.#rejectTurn(error);
      await terminal.catch(() => undefined);
      throw error;
    }
    const turnId = text(record(response.turn).id);
    if (turnId.length === 0) {
      this.#rejectTurn(new Error("Codex turn response omitted turn.id"));
      throw new Error("Codex turn response omitted turn.id");
    }
    if (this.#activeTurnId !== null && this.#activeTurnId !== turnId) {
      this.#rejectTurn(new Error("Codex turn identity changed during start"));
      throw new Error("Codex turn identity changed during start");
    }
    if (this.#turnWaiter !== null) this.#activeTurnId = turnId;
    const lastUser = this.#transcript.at(-1);
    if (lastUser?.role === "user" && lastUser.turnId === null) lastUser.turnId = turnId;
    await this.#persist();
    const result = await terminal;
    await this.#persist();
    return { ...result, snapshot: this.snapshot() };
  }

  async interrupt(reason = "operator interrupted turn"): Promise<Phase7LiveSessionSnapshot> {
    if (this.#transport === null || this.#activeTurnId === null) return this.snapshot();
    this.#status = "stopping";
    const turnId = this.#activeTurnId;
    this.#appendEvidence("session", turnId, { action: "stop_requested", reason });
    await this.#transport.request("turn/interrupt", {
      threadId: this.#providerThreadId,
      turnId,
    });
    await this.#persist();
    return this.snapshot();
  }

  async resolveInteraction(input: Phase7InteractionResolution): Promise<Phase7LiveTurnResult> {
    const interaction = pendingInteractions(this.#port).find(
      (candidate) => candidate.id === input.interactionId,
    );
    if (interaction === undefined) throw new Error("interaction is not pending in this session");
    const outcome = await this.#port.tryApplyCommand({
      runId: this.#authority.runId,
      idempotencyKey: `phase7-live-interaction:${input.interactionId}:${input.outcome}`,
      command: {
        kind: "resolve_human_input",
        interactionId: input.interactionId,
        outcome: input.outcome,
        result: input.result,
      },
    });
    if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
    this.#appendEvidence("interaction", null, {
      interactionId: input.interactionId,
      interactionKind: interaction.kind,
      outcome: input.outcome,
      result: input.result,
      stateRevision: outcome.result.stateRevision,
    });
    await this.#persist();
    return this.sendMessage(JSON.stringify({
      schema: "paperclip.semantic-interaction-result.v1",
      interactionId: input.interactionId,
      kind: interaction.kind,
      outcome: input.outcome,
      result: input.result,
      instruction: "Continue using this typed interaction result in the same mock issue session.",
    }));
  }

  async reconnect(): Promise<void> {
    if (this.#activeTurnId !== null) {
      throw new Error("stop the active turn before reconnecting the Codex transport");
    }
    await this.#disconnect("reconnect");
    await this.#connect(true);
  }

  async shutdown(reason: string): Promise<void> {
    if (this.#activeTurnId !== null) {
      try {
        await this.interrupt(reason);
      } catch (error) {
        this.#appendEvidence("diagnostic", this.#activeTurnId, {
          message: redactCodexDiagnostic(String(error)),
        });
      }
    }
    await this.#disconnect(reason);
    await this.#port.stop();
    this.#authority.active = false;
    this.#status = "closed";
    this.#appendEvidence("cleanup", null, {
      reason,
      authorityCleared: true,
      mockStopped: true,
      processExited: this.#processEvidence?.runnerExited ?? true,
    });
    await this.#persist();
  }

  async #connect(resume: boolean): Promise<void> {
    this.#status = "starting";
    const transportBundle = this.#transportFactory({
      ...this.#transportOptions,
      onDiagnostic: (message) => {
        this.#transportOptions.onDiagnostic?.(message);
        this.#appendEvidence("diagnostic", this.#activeTurnId, {
          message: redactCodexDiagnostic(message),
        });
      },
      onEvidence: (evidence) => {
        this.#processEvidence = structuredClone(evidence);
        this.#transportOptions.onEvidence?.(evidence);
      },
    });
    this.#transport = transportBundle.transport;
    this.#processEvidence = structuredClone(transportBundle.evidence());
    this.#transport.setServerRequestHandler((request) => this.#handleServerRequest(request));
    const initialized = await this.#transport.request("initialize", {
      clientInfo: {
        name: "paperclip-runner",
        title: "Paperclip Runner Phase 7",
        version: "phase7-v1",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.#transport.notify("initialized");
    const tools = this.#dispatcher.listTools(this.#authority.runId);
    this.#appendEvidence("tool_exposure", null, {
      operationIds: tools.map((tool) => tool.name),
      scenarioId: this.#config.scenario.id,
    });
    if (resume) {
      const read = await this.#transport.request("thread/read", {
        threadId: this.#providerThreadId,
        includeTurns: true,
      });
      const thread = record(read.thread);
      if (text(thread.id) !== this.#providerThreadId) {
        throw new Error("Codex reconnect read a different provider thread");
      }
      const resumed = await this.#transport.request("thread/resume", {
        threadId: this.#providerThreadId,
        cwd: this.#config.workingDirectory,
        config: createSkilllessCodexThreadConfig(this.#config.workingDirectory),
        permissions: CODEX_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#config.workingDirectory],
        baseInstructions: LIVE_BASE_INSTRUCTIONS,
        persistExtendedHistory: true,
      });
      const resumedThread = record(resumed.thread);
      if (text(resumedThread.id) !== this.#providerThreadId) {
        throw new Error("Codex reconnect resumed a different provider thread");
      }
      this.#providerSessionId = text(resumedThread.sessionId) || this.#providerSessionId;
      this.#activeTurnId = null;
    } else {
      const opened = await this.#transport.request("thread/start", {
        cwd: this.#config.workingDirectory,
        config: createSkilllessCodexThreadConfig(this.#config.workingDirectory),
        permissions: CODEX_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#config.workingDirectory],
        approvalPolicy: "never",
        baseInstructions: LIVE_BASE_INSTRUCTIONS,
        dynamicTools: tools.map(dynamicToolSpec),
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
      const thread = record(opened.thread);
      this.#providerThreadId = text(thread.id);
      if (this.#providerThreadId.length === 0) throw new Error("Codex thread response omitted thread.id");
      this.#providerSessionId = text(thread.sessionId) || text(record(initialized.user).sessionId) || null;
    }
    this.#status = "idle";
    this.#appendEvidence("session", null, {
      action: resume ? "resumed" : "started",
      sessionId: this.id,
      providerThreadId: this.#providerThreadId,
      providerSessionId: this.#providerSessionId,
      mode: "live_codex",
      runner: "paperclip-runnerd",
      controlPlane: "mock",
    });
    this.#pump = this.#pumpNotifications();
    await this.#persist();
  }

  async #disconnect(reason: string): Promise<void> {
    const transport = this.#transport;
    this.#transport = null;
    if (transport !== null) await transport.close();
    if (this.#pump !== null) await this.#pump.catch(() => undefined);
    this.#pump = null;
    this.#appendEvidence("process", null, {
      action: "transport_closed",
      reason,
      runnerExited: this.#processEvidence?.runnerExited ?? true,
      runnerPid: this.#processEvidence?.runnerPid ?? null,
      codexPid: this.#processEvidence?.codexPid ?? null,
    });
  }

  async #handleServerRequest(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    if (request.method !== "item/tool/call") {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Unsupported Codex client request." }],
      };
    }
    const operationId = text(request.params.tool);
    const threadId = text(request.params.threadId);
    const turnId = text(request.params.turnId);
    const callId = text(request.params.callId, String(request.id));
    if (
      threadId !== this.#providerThreadId ||
      turnId.length === 0 ||
      turnId !== this.#activeTurnId ||
      callId.length === 0
    ) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Tool call was outside the active Phase 7 thread and turn." }],
      };
    }
    const beforeRevision = this.#port.snapshot().revision;
    this.#appendEvidence("tool_call", turnId, {
      callId,
      operationId,
      input: jsonValue(request.params.arguments),
      beforeRevision,
    });
    const result = await this.#dispatcher.dispatch({
      runId: this.#authority.runId,
      callId,
      operationId,
      input: request.params.arguments,
    });
    this.#appendEvidence("tool_result", turnId, {
      callId,
      operationId,
      result: jsonValue(result),
      beforeRevision,
      afterRevision: result.stateRevision,
    });
    await this.#persist();
    return this.#codexToolResponse(result);
  }

  #codexToolResponse(result: Phase7SemanticToolResult): Record<string, unknown> {
    return {
      success: result.ok,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify(result),
      }],
    };
  }

  async #pumpNotifications(): Promise<void> {
    const transport = this.#transport;
    if (transport === null) return;
    try {
      for await (const notification of transport.notifications()) {
        this.#handleNotification(notification);
      }
    } catch (error) {
      if (this.#transport !== transport) return;
      this.#status = "failed";
      this.#appendEvidence("diagnostic", this.#activeTurnId, {
        message: redactCodexDiagnostic(String(error)),
      });
      this.#rejectTurn(error);
      await this.#persist();
    }
  }

  #handleNotification(notification: CodexRpcNotification): void {
    const params = notification.params;
    const turn = record(params.turn);
    const item = record(params.item);
    const turnId = text(params.turnId, text(turn.id));
    this.#appendEvidence("provider_event", turnId || null, {
      method: notification.method,
      params: jsonValue(params),
    });
    if (notification.method === "turn/started") {
      if (turnId.length > 0) this.#activeTurnId = turnId;
    } else if (notification.method === "item/agentMessage/delta") {
      if (this.#turnWaiter !== null) this.#turnWaiter.assistantText += text(params.delta);
    } else if (notification.method === "item/completed" && text(item.type) === "agentMessage") {
      const assistantText = text(item.text);
      if (assistantText.length > 0 && this.#turnWaiter !== null) {
        this.#turnWaiter.assistantText = assistantText;
      }
    } else if (notification.method === "turn/completed") {
      this.#completeTurn(turnId, terminalStatus(turn.status));
    }
    void this.#persist();
  }

  #completeTurn(turnId: string, status: Phase7LiveTurnResult["status"]): void {
    const waiter = this.#turnWaiter;
    if (waiter === null) return;
    clearTimeout(waiter.timer);
    this.#turnWaiter = null;
    const assistantText = waiter.assistantText.trim();
    if (assistantText.length > 0) this.#appendTranscript("assistant", assistantText, turnId);
    this.#activeTurnId = null;
    this.#status = "idle";
    waiter.resolve({ turnId, status, assistantText });
  }

  #rejectTurn(error: unknown): void {
    const waiter = this.#turnWaiter;
    if (waiter === null) return;
    clearTimeout(waiter.timer);
    this.#turnWaiter = null;
    this.#activeTurnId = null;
    this.#status = "failed";
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  #appendTranscript(role: Phase7LiveTranscriptEntry["role"], message: string, turnId: string | null): void {
    this.#entryCounter += 1;
    this.#transcript.push({
      id: `transcript-${String(this.#entryCounter).padStart(6, "0")}`,
      role,
      text: message,
      turnId,
      at: this.#now().toISOString(),
    });
  }

  #appendEvidence(
    kind: Phase7LiveEvidenceEntry["kind"],
    turnId: string | null,
    data: Record<string, unknown>,
  ): void {
    this.#entryCounter += 1;
    this.#evidence.push({
      id: `evidence-${String(this.#entryCounter).padStart(6, "0")}`,
      kind,
      at: this.#now().toISOString(),
      turnId,
      data: jsonValue(data) as Record<string, Phase7JsonValue>,
    });
    if (this.#evidence.length > 2_000) this.#evidence.splice(0, this.#evidence.length - 2_000);
  }

  #persist(): Promise<void> {
    this.#revision += 1;
    this.#updatedAt = this.#now().toISOString();
    const snapshot = this.snapshot();
    this.#persistChain = this.#persistChain.then(() => this.#store.save(snapshot));
    return this.#persistChain;
  }
}

export function phase7InteractionKindFromMock(
  kind: Phase7InteractionKind,
): "ask_user_questions" | "request_confirmation" | "request_checkbox_confirmation" | "request_item_verdicts" | "suggest_tasks" {
  if (kind === "questions") return "ask_user_questions";
  if (kind === "confirmation") return "request_confirmation";
  if (kind === "checkbox") return "request_checkbox_confirmation";
  if (kind === "item_verdicts") return "request_item_verdicts";
  return "suggest_tasks";
}

export type { Phase7OpenFixtureRunInput };

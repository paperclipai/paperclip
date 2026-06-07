import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { parseCodexJsonl } from "@paperclipai/adapter-codex-local/server";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
} from "./utils.js";

type JsonRpcId = string | number;

type JsonRpcResponse = {
  id?: JsonRpcId;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type CachedUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
};

const REMOTE_URL_HINT =
  "Set adapterConfig.appServerUrl to a ws:// or wss:// Codex App Server endpoint.";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return fallback;
}

function parseHeaderConfig(input: unknown): Record<string, string> {
  const record = parseObject(input);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && key.trim().length > 0) headers[key] = value;
  }
  return headers;
}

function resolveAppServerConfig(config: Record<string, unknown>) {
  // Keep accepting `remoteControlUrl` as an alias so existing experiments do not
  // break when the feature name settles on `appServerUrl`.
  const url = nonEmpty(config.appServerUrl) ?? nonEmpty(config.remoteControlUrl);
  const headers = parseHeaderConfig(config.appServerHeaders);
  const bearerToken = nonEmpty(config.appServerBearerToken);
  // The dedicated token field is the operator-facing path in Paperclip. If it is
  // set, let it define Authorization even when advanced users also supplied raw
  // headers through appServerHeaders.
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return { url, headers, bearerToken };
}

function isRemoteCodexConfig(config: Record<string, unknown>): boolean {
  return Boolean(resolveAppServerConfig(config).url);
}

function parseWsUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return parsed;
    return null;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function looksLikeRemoteMissingThread(message: string): boolean {
  return /thread .* not found|unknown thread|missing rollout path/i.test(message);
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function createTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

async function readInstructionsPrefix(
  instructionsFilePath: string,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ prefix: string; notes: string[] }> {
  const trimmed = instructionsFilePath.trim();
  if (!trimmed) return { prefix: "", notes: [] };

  const instructionsDir = `${path.dirname(trimmed)}/`;
  try {
    const instructionsContents = await fs.readFile(trimmed, "utf8");
    await onLog("stderr", `[paperclip] Loaded agent instructions file: ${trimmed}\n`);
    return {
      prefix:
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${trimmed}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`,
      notes: [
        `Loaded agent instructions from ${trimmed}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
      ],
    };
  } catch (err) {
    const reason = toErrorMessage(err, "could not read instructions file");
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${trimmed}": ${reason}\n`,
    );
    return {
      prefix: "",
      notes: [
        `Configured instructionsFilePath ${trimmed}, but file could not be read; continuing without injected instructions.`,
      ],
    };
  }
}

function buildRemoteRuntimeNote(env: Record<string, string>): { plain: string; redacted: string } {
  const entries = Object.entries(env).filter(([, value]) => value.trim().length > 0);
  if (entries.length === 0) return { plain: "", redacted: "" };

  const plainLines = entries.map(([key, value]) => `${key}=${value}`);
  const redactedEnv = redactEnvForLogs(env);
  const redactedLines = Object.entries(redactedEnv).map(([key, value]) => `${key}=${String(value)}`);
  // Local `codex exec` inherits env directly. A remote App Server does not, so we
  // inject an explicit note into the prompt to prevent agents from assuming the
  // Paperclip env vars already exist in the remote shell.
  const prefix =
    "Remote Codex App Server note: these values are available for this run, but they are not automatically exported into the remote shell. Export them manually before using curl, scripts, or Paperclip API commands.\n";
  return {
    plain: `${prefix}${plainLines.join("\n")}\n\n`,
    redacted: `${prefix}${redactedLines.join("\n")}\n\n`,
  };
}

function buildPrompt(
  ctx: AdapterExecutionContext,
  cwd: string,
  promptTemplate: string,
  instructionsPrefix: string,
  remoteRuntimeNote: string,
): string {
  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    company: { id: ctx.agent.companyId },
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context: ctx.context,
  });
  const cwdPrefix = cwd ? `Remote workspace cwd: ${cwd}\n\n` : "";
  return `${instructionsPrefix}${remoteRuntimeNote}${cwdPrefix}${renderedPrompt}`;
}

function createLegacyEvent(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

function firstReasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary.filter((entry): entry is string => typeof entry === "string") : [];
  const content = Array.isArray(item.content) ? item.content.filter((entry): entry is string => typeof entry === "string") : [];
  return summary.join("\n").trim() || content.join("\n").trim();
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToolName(item: Record<string, unknown>): string {
  const namespace = nonEmpty(item.namespace);
  const server = nonEmpty(item.server);
  const tool = nonEmpty(item.tool) ?? "unknown";
  if (namespace) return `${namespace}.${tool}`;
  if (server) return `${server}.${tool}`;
  return tool;
}

function toLegacyToolResult(item: Record<string, unknown>): Record<string, unknown> {
  const id = asString(item.id, "tool");
  const error = item.error;
  const result = item.result;
  const status = asString(item.status, "");
  const content =
    stringifyUnknown(error) ||
    stringifyUnknown(result) ||
    status ||
    "tool completed";
  return {
    id,
    type: "tool_result",
    tool_use_id: id,
    content,
    is_error: error != null || /error|fail/i.test(status),
    status,
  };
}

function mapLegacyItemEvent(
  phase: "started" | "completed",
  itemRaw: unknown,
): Record<string, unknown> | null {
  // The rest of Paperclip already understands Codex CLI JSONL. Remote App Server
  // mode deliberately translates back into that older event shape so transcript
  // parsing, summaries, and tests do not need a second parallel code path.
  const item = asRecord(itemRaw);
  if (!item) return null;
  const type = asString(item.type, "");

  if (phase === "started") {
    if (type === "commandExecution") {
      return {
        type: "item.started",
        item: {
          id: asString(item.id, ""),
          type: "command_execution",
          command: asString(item.command, ""),
          status: asString(item.status, ""),
        },
      };
    }
    if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") {
      return {
        type: "item.started",
        item: {
          id: asString(item.id, ""),
          type: "tool_use",
          name: type === "webSearch" ? "web_search" : normalizeToolName(item),
          input: item.arguments ?? item.action ?? { query: item.query ?? "" },
        },
      };
    }
    if (type === "reasoning") {
      return {
        type: "item.started",
        item: {
          id: asString(item.id, ""),
          type: "reasoning",
          text: firstReasoningText(item),
        },
      };
    }
    return null;
  }

  if (type === "agentMessage") {
    return {
      type: "item.completed",
      item: {
        id: asString(item.id, ""),
        type: "assistant_message",
        text: asString(item.text, ""),
      },
    };
  }
  if (type === "reasoning") {
    return {
      type: "item.completed",
      item: {
        id: asString(item.id, ""),
        type: "reasoning",
        text: firstReasoningText(item),
      },
    };
  }
  if (type === "commandExecution") {
    return {
      type: "item.completed",
      item: {
        id: asString(item.id, ""),
        type: "command_execution",
        command: asString(item.command, ""),
        aggregated_output: asString(item.aggregatedOutput, ""),
        exit_code:
          typeof item.exitCode === "number" && Number.isFinite(item.exitCode) ? item.exitCode : null,
        status: asString(item.status, ""),
      },
    };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes
          .map((change) => asRecord(change))
          .filter((change): change is Record<string, unknown> => Boolean(change))
          .map((change) => ({
            path: asString(change.path, ""),
            kind: asString(change.kind, "update"),
          }))
      : [];
    return {
      type: "item.completed",
      item: {
        id: asString(item.id, ""),
        type: "file_change",
        changes,
        status: asString(item.status, ""),
      },
    };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") {
    return {
      type: "item.completed",
      item: toLegacyToolResult(item),
    };
  }
  return null;
}

class CodexAppServerClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly onNotification: (message: JsonRpcNotification) => Promise<void> | void,
    private readonly onServerRequest: (message: JsonRpcRequest) => Promise<void> | void,
  ) {}

  async connect(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { headers: this.headers });
      this.ws = ws;

      const timer = setTimeout(() => {
        ws.terminate();
        reject(createTimeoutError(`Timed out connecting to Codex App Server after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("message", (data) => {
        void this.handleMessage(data);
      });
      ws.once("close", () => {
        for (const [id, pending] of this.pending) {
          pending.reject(new Error(`Codex App Server connection closed while waiting for request ${String(id)}`));
        }
        this.pending.clear();
      });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "paperclip",
        title: "Paperclip",
        version: "0.2.7",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    this.notify("initialized");
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send(payload);
    });
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcId, result: unknown) {
    this.send({ id, result });
  }

  respondError(id: JsonRpcId, message: string, code = -32000) {
    this.send({ id, error: { code, message } });
  }

  async close() {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
      setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve();
      }, 500).unref?.();
    });
  }

  private send(payload: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex App Server WebSocket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private async handleMessage(data: WebSocket.RawData) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;
    if (record.method && record.id !== undefined) {
      await this.onServerRequest(record as JsonRpcRequest);
      return;
    }
    if (record.method) {
      await this.onNotification(record as JsonRpcNotification);
      return;
    }

    const response = record as JsonRpcResponse;
    if (response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(nonEmpty(response.error.message) ?? `Codex App Server request ${String(response.id)} failed`));
      return;
    }
    pending.resolve(response.result);
  }
}

export async function executeCodexViaAppServer(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { runtime, config, context, onLog, onMeta, authToken, runId, agent } = ctx;
  const { url, headers } = resolveAppServerConfig(config);
  if (!url) throw new Error("Codex App Server execution requires adapterConfig.appServerUrl");

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const configuredCwd = asString(config.cwd, "").trim();
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "").trim();
  const cwd = configuredCwd || workspaceCwd;
  const model = asString(config.model, "").trim();
  const modelReasoningEffort = asString(
    config.modelReasoningEffort,
    asString(config.reasoningEffort, ""),
  ).trim();
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 5 * 60 * 1000;
  const bypass = asBoolean(
    config.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(config.dangerouslyBypassSandbox, false),
  );
  const search = asBoolean(config.search, false);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  if (!bypass) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "Remote Codex App Server mode currently requires bypass sandbox enabled so Paperclip does not block on interactive approval requests.",
      provider: "openai",
      model: model || null,
      billingType: "unknown",
      costUsd: null,
      clearSession: false,
    };
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (authToken && !nonEmpty(env.PAPERCLIP_API_KEY)) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const instructions = await readInstructionsPrefix(asString(config.instructionsFilePath, ""), onLog);
  const remoteRuntimeNote = buildRemoteRuntimeNote(env);
  const prompt = buildPrompt(ctx, cwd, promptTemplate, instructions.prefix, remoteRuntimeNote.plain);
  const metaPrompt = buildPrompt(ctx, cwd, promptTemplate, instructions.prefix, remoteRuntimeNote.redacted);

  const commandNotes = [...instructions.notes];
  commandNotes.push(`Using Codex App Server over WebSocket: ${url}`);
  if (search) {
    commandNotes.push("Configured search=true is currently ignored for remote App Server execution.");
  }
  if (extraArgs.length > 0) {
    commandNotes.push("Configured extraArgs/args are currently ignored for remote App Server execution.");
  }

  if (onMeta) {
    await onMeta({
      adapterType: "codex_local",
      command: "codex-app-server",
      cwd,
      commandArgs: [url],
      commandNotes,
      env: redactEnvForLogs(env),
      prompt: metaPrompt,
      context,
    });
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const usageByTurn = new Map<string, CachedUsage>();
  const loggedThreads = new Set<string>();
  let activeTurnId: string | null = null;
  let turnCompletedResolve: ((value: void | PromiseLike<void>) => void) | null = null;
  let turnCompletedReject: ((reason?: unknown) => void) | null = null;
  let timedOut = false;

  const pushStdoutEvent = async (event: Record<string, unknown>) => {
    const line = createLegacyEvent(event);
    stdoutChunks.push(line);
    await onLog("stdout", line);
  };

  const pushStderr = async (message: string) => {
    const chunk = message.endsWith("\n") ? message : `${message}\n`;
    stderrChunks.push(chunk);
    await onLog("stderr", chunk);
  };

  const client = new CodexAppServerClient(
    url,
    headers,
    async (message) => {
      const params = asRecord(message.params) ?? {};
      switch (message.method) {
        case "thread/started": {
          const thread = asRecord(params.thread);
          const threadId = asString(thread?.id, "");
          if (threadId && !loggedThreads.has(threadId)) {
            loggedThreads.add(threadId);
            await pushStdoutEvent({
              type: "thread.started",
              thread_id: threadId,
              session_id: asString(thread?.sessionId, threadId),
              model,
            });
          }
          return;
        }
        case "turn/started":
          await pushStdoutEvent({ type: "turn.started" });
          return;
        case "item/started":
        case "item/completed": {
          const mapped = mapLegacyItemEvent(
            message.method === "item/started" ? "started" : "completed",
            params.item,
          );
          if (mapped) {
            await pushStdoutEvent(mapped);
          }
          return;
        }
        case "thread/tokenUsage/updated": {
          const turnId = asString(params.turnId, "");
          const tokenUsage = asRecord(params.tokenUsage);
          const last = asRecord(tokenUsage?.last);
          if (!turnId || !last) return;
          usageByTurn.set(turnId, {
            input_tokens: typeof last.inputTokens === "number" ? last.inputTokens : 0,
            cached_input_tokens: typeof last.cachedInputTokens === "number" ? last.cachedInputTokens : 0,
            output_tokens: typeof last.outputTokens === "number" ? last.outputTokens : 0,
          });
          return;
        }
        case "turn/completed": {
          const turn = asRecord(params.turn);
          const turnId = asString(turn?.id, asString(params.turnId, ""));
          const status = asString(turn?.status, "completed");
          const usage = usageByTurn.get(turnId ?? "");
          if (status === "failed") {
            const error = asRecord(turn?.error);
            await pushStdoutEvent({
              type: "turn.failed",
              error: { message: asString(error?.message, "Codex App Server turn failed") },
              usage,
            });
          } else {
            await pushStdoutEvent({
              type: "turn.completed",
              usage,
            });
          }
          if (turnId && activeTurnId === turnId && turnCompletedResolve) {
            turnCompletedResolve();
          }
          return;
        }
        case "error": {
          const error = asRecord(params.error);
          await pushStdoutEvent({
            type: "turn.failed",
            error: { message: asString(error?.message, "Codex App Server error") },
            usage: usageByTurn.get(asString(params.turnId, "")),
          });
          if (turnCompletedReject) {
            turnCompletedReject(new Error(asString(error?.message, "Codex App Server error")));
          }
          return;
        }
        case "warning": {
          const messageText = nonEmpty(params.message) ?? stringifyUnknown(params);
          await pushStderr(`[paperclip] Codex App Server warning: ${messageText}`);
          return;
        }
        default:
          return;
      }
    },
    async (message) => {
      // In local CLI mode Codex can stop and ask for approvals or tool input.
      // Paperclip's remote adapter does not currently have an interactive reviewer
      // loop for App Server requests, so fail loudly here instead of hanging.
      client.respondError(
        message.id,
        `Paperclip does not support interactive App Server request ${message.method} in remote mode.`,
      );
      await pushStderr(`[paperclip] Unsupported Codex App Server request: ${message.method}`);
    },
  );

  const run = async () => {
    await client.connect(Math.min(timeoutMs, 15_000));
    await client.initialize();

    let threadId = asString(parseObject(runtime.sessionParams).sessionId, runtime.sessionId ?? "");
    if (threadId) {
      try {
        const response = asRecord(
          await client.request("thread/resume", {
            threadId,
            ...(cwd ? { cwd } : {}),
            ...(model ? { model } : {}),
          }),
        );
        const thread = asRecord(response?.thread);
        const resumedThreadId = asString(thread?.id, threadId);
        if (resumedThreadId && !loggedThreads.has(resumedThreadId)) {
          loggedThreads.add(resumedThreadId);
          await pushStdoutEvent({
            type: "thread.started",
            thread_id: resumedThreadId,
            session_id: asString(thread?.sessionId, resumedThreadId),
            model,
          });
        }
        threadId = resumedThreadId;
      } catch (err) {
        const message = toErrorMessage(err, "failed to resume Codex App Server thread");
        // Remote threads can disappear if the server was reset or its local state
        // was pruned. Match that behavior to the local CLI adapter: warn, drop the
        // stale session, and start a fresh thread instead of failing the whole run.
        if (!looksLikeRemoteMissingThread(message)) throw err;
        await pushStderr(
          `[paperclip] Codex App Server thread "${threadId}" is unavailable; retrying with a fresh session.`,
        );
        threadId = "";
      }
    }

    if (!threadId) {
      const response = asRecord(
        await client.request("thread/start", {
          ...(cwd ? { cwd } : {}),
          ...(model ? { model } : {}),
          approvalPolicy: "never",
        }),
      );
      const thread = asRecord(response?.thread);
      threadId = asString(thread?.id, "");
      if (threadId && !loggedThreads.has(threadId)) {
        loggedThreads.add(threadId);
        await pushStdoutEvent({
          type: "thread.started",
          thread_id: threadId,
          session_id: asString(thread?.sessionId, threadId),
          model: asString(response?.model, model),
        });
      }
    }

    if (!threadId) {
      throw new Error("Codex App Server did not return a thread id");
    }

    const turnPromise = new Promise<void>((resolve, reject) => {
      turnCompletedResolve = resolve;
      turnCompletedReject = reject;
    });

    const turnStartResponse = asRecord(
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(modelReasoningEffort ? { effort: modelReasoningEffort } : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    );
    const turnRecord = asRecord(turnStartResponse?.turn);

    activeTurnId = asString(turnRecord?.id, "");
    if (!activeTurnId) {
      throw new Error("Codex App Server did not return a turn id");
    }

    await turnPromise;

    return threadId;
  };

  try {
    const threadId = await Promise.race<string>([
      run(),
      new Promise<string>((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(createTimeoutError(`Timed out after ${timeoutSec > 0 ? timeoutSec : timeoutMs / 1000}s`));
        }, timeoutMs).unref?.();
      }),
    ]);

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");
    const parsed = parseCodexJsonl(stdout);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: parsed.usage,
      sessionId: threadId,
      sessionParams: { sessionId: threadId, ...(cwd ? { cwd } : {}) },
      sessionDisplayId: threadId,
      provider: "openai",
      model: model || null,
      billingType: "unknown",
      costUsd: null,
      resultJson: { stdout, stderr },
      summary: parsed.summary,
      clearSession: false,
    };
  } catch (err) {
    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");
    const parsed = parseCodexJsonl(stdout);
    return {
      exitCode: 1,
      signal: null,
      timedOut,
      errorMessage: toErrorMessage(err, firstNonEmptyLine(stderr) || "Codex App Server execution failed"),
      usage: parsed.usage,
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      provider: "openai",
      model: model || null,
      billingType: "unknown",
      costUsd: null,
      resultJson: { stdout, stderr },
      summary: parsed.summary,
      clearSession: false,
    };
  } finally {
    await client.close();
  }
}

export async function testCodexAppServerEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const { url, headers, bearerToken } = resolveAppServerConfig(config);

  if (!url) {
    checks.push({
      code: "codex_app_server_url_missing",
      level: "error",
      message: "Codex remote mode requires adapterConfig.appServerUrl.",
      hint: REMOTE_URL_HINT,
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const parsedUrl = parseWsUrl(url);
  if (!parsedUrl) {
    checks.push({
      code: "codex_app_server_url_invalid",
      level: "error",
      message: `Invalid Codex App Server URL: ${url}`,
      hint: "Use a ws:// or wss:// URL.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "codex_app_server_url_valid",
    level: "info",
    message: `Configured Codex App Server endpoint: ${parsedUrl.toString()}`,
  });

  if (Object.keys(headers).length > 0) {
    checks.push({
      code: "codex_app_server_headers_present",
      level: "info",
      message: `Configured ${Object.keys(headers).length} WebSocket header(s) for remote Codex auth.`,
    });
  }

  if (bearerToken) {
    checks.push({
      code: "codex_app_server_bearer_token_present",
      level: "info",
      message: "Configured a bearer token for the Codex App Server WebSocket handshake.",
    });
    if (parsedUrl.protocol !== "wss:" && !isLoopbackHost(parsedUrl.hostname)) {
      checks.push({
        code: "codex_app_server_bearer_token_insecure_transport",
        level: "warn",
        message: "Bearer-token App Server auth should use wss:// or a loopback ws:// listener.",
        hint: "Prefer SSH port forwarding or a loopback listener when configuring appServerBearerToken.",
      });
    }
  }

  if (!asBoolean(
    config.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(config.dangerouslyBypassSandbox, false),
  )) {
    checks.push({
      code: "codex_app_server_bypass_recommended",
      level: "warn",
      message: "Remote Codex App Server runs are expected to use bypass sandbox to avoid interactive approval deadlocks.",
      hint: "Enable bypass sandbox for codex_local when using appServerUrl.",
    });
  }

  const client = new CodexAppServerClient(parsedUrl.toString(), headers, async () => {}, async (message) => {
    client.respondError(message.id, `Unsupported request during environment test: ${message.method}`);
  });

  try {
    await client.connect(5_000);
    checks.push({
      code: "codex_app_server_connect_ok",
      level: "info",
      message: "Connected to Codex App Server.",
    });

    await client.initialize();
    checks.push({
      code: "codex_app_server_initialize_ok",
      level: "info",
      message: "Codex App Server initialize handshake succeeded.",
    });

    const auth = asRecord(
      await client.request("getAuthStatus", {
        includeToken: false,
        refreshToken: false,
      }),
    );
    const authMethod = nonEmpty(auth?.authMethod);
    const requiresOpenAiAuth = auth?.requiresOpenaiAuth === true;
    if (authMethod) {
      checks.push({
        code: "codex_app_server_auth_ready",
        level: "info",
        message: `Codex App Server auth method: ${authMethod}.`,
      });
    } else if (requiresOpenAiAuth) {
      checks.push({
        code: "codex_app_server_auth_missing",
        level: "warn",
        message: "Codex App Server is reachable, but OpenAI authentication is not configured.",
        hint: "Authenticate Codex on the remote host or configure the remote server with the required auth mode.",
      });
    } else {
      checks.push({
        code: "codex_app_server_auth_not_required",
        level: "info",
        message: "Codex App Server did not report a required OpenAI auth method.",
      });
    }
  } catch (err) {
    checks.push({
      code: "codex_app_server_probe_failed",
      level: "error",
      message: toErrorMessage(err, "Failed to reach Codex App Server"),
      hint: "Verify the WebSocket URL, auth headers, and remote app-server listener configuration.",
    });
  } finally {
    await client.close();
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

export { isRemoteCodexConfig };

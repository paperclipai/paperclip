import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
  STOP_GRACE_MS,
} from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

type SseFrame = {
  event: string | null;
  data: string;
};

type HermesHttpError = Error & {
  status?: number;
  code?: string;
  retryNotBefore?: string | null;
  body?: unknown;
};

type TerminalState = {
  runId: string;
  status: string;
  eventName?: string | null;
  payload?: Record<string, unknown> | null;
  output?: string | null;
};

type ExecutionState = {
  runId: string;
  outputChunks: string[];
  lastEventName: string | null;
  terminal: TerminalState | null;
  resolveTerminal: (state: TerminalState) => void;
  terminalPromise: Promise<TerminalState>;
};

type TextRedactor = (value: string) => string;

const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  "x-hermes-session-key",
]);

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)/i;
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi;
const HERMES_SESSION_KEY_HEADER_PATTERN = /(X-Hermes-Session-Key\s*[:=]\s*)([^\s,;]+)/gi;
const PAPERCLIP_SESSION_KEY_PATTERN =
  /\bpaperclip:(?:company:[A-Za-z0-9-]+:agent:[A-Za-z0-9-]+(?::(?:issue|run):[A-Za-z0-9-]+)?|run:[A-Za-z0-9-]+)\b/gi;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
]);

const FAILURE_STATUSES = new Set(["failed", "error"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "stopped", "interrupted"]);
const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = asString(value, "issue").trim().toLowerCase();
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (
      url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
      HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
    ) {
      url.pathname = "/api";
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(HERMES_SESSION_KEY_HEADER_PATTERN, "$1[redacted]")
    .replace(PAPERCLIP_SESSION_KEY_PATTERN, "[redacted-session-key]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTextRedactor(secrets: Array<string | null | undefined>): TextRedactor {
  const exactSecrets = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({
      secret,
      regex: new RegExp(escapeRegExp(secret), "g"),
    }));

  return (value: string) => {
    let result = sanitizeSensitiveText(value);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0, redactText: TextRedactor = sanitizeSensitiveText): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    const sanitized = redactText(value);
    return sanitized.length > 500
      ? `${sanitized.slice(0, 500)}... [truncated ${sanitized.length - 500} chars]`
      : sanitized;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value.slice(0, 40).map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

function parseHeaders(value: unknown): Record<string, string> {
  const source =
    typeof value === "string" && value.trim().length > 0
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value;
  const parsed = parseObject(source);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = key.trim();
    if (!normalized || CRITICAL_HEADERS.has(normalized.toLowerCase())) continue;
    if (typeof entry === "string") headers[normalized] = entry;
  }
  return headers;
}

function buildHeaders(input: {
  apiKey: string;
  sessionKey: string | null;
  runId: string;
  extraHeaders: Record<string, string>;
  accept: string;
  contentType?: string;
}): Record<string, string> {
  return {
    ...input.extraHeaders,
    Authorization: `Bearer ${input.apiKey}`,
    Accept: input.accept,
    ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    "Idempotency-Key": input.runId,
    ...(input.sessionKey ? { "X-Hermes-Session-Key": input.sessionKey } : {}),
  };
}

function buildInput(ctx: AdapterExecutionContext, paperclipApiUrl: string | null): string {
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const wakePayloadJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const taskMarkdown = nonEmpty(ctx.context.paperclipTaskMarkdown);
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  const lines = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    ...(paperclipApiUrl ? [`- Paperclip API URL: ${paperclipApiUrl}`] : []),
    ...(issueWorkMode ? [`- Issue work mode: ${issueWorkMode}`] : []),
    "",
    "Execution contract:",
    "- Take concrete action in this run when the task is actionable.",
    "- Do not stop at a plan unless the issue asks for planning only.",
    "- Leave durable progress and update the issue to a clear final disposition.",
    "- Use X-Paperclip-Run-Id on mutating Paperclip API requests when a Paperclip API key is available.",
    "",
    wakePrompt,
    ...(sessionHandoff ? ["", sessionHandoff] : []),
    ...(taskMarkdown ? ["", taskMarkdown] : []),
    ...(wakePayloadJson
      ? [
          "",
          "Structured wake payload JSON:",
          "```json",
          wakePayloadJson,
          "```",
        ]
      : []),
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

function buildRunBody(ctx: AdapterExecutionContext, sessionKey: string | null): Record<string, unknown> {
  const paperclipApiUrl = nonEmpty(ctx.config.paperclipApiUrl);
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  const input = nonEmpty(payloadTemplate.input) ?? buildInput(ctx, paperclipApiUrl);
  const instructions =
    nonEmpty(ctx.config.instructions) ??
    nonEmpty(payloadTemplate.instructions) ??
    "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.";
  return {
    ...payloadTemplate,
    input,
    instructions,
    ...(sessionKey ? { session_id: sessionKey } : {}),
  };
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function classifyHttpError(status: number): { code: string; family: AdapterExecutionResult["errorFamily"] | null } {
  if (status === 401 || status === 403) return { code: "hermes_gateway_auth_failed", family: null };
  if (status === 404) return { code: "hermes_gateway_runs_unsupported", family: null };
  if (status === 429) return { code: "hermes_gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "hermes_gateway_upstream_error", family: "transient_upstream" };
  return { code: "hermes_gateway_protocol_error", family: null };
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;

  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

async function fetchJson(input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    const fetchErr = new Error(`Hermes gateway request failed: ${fetchFailureMessage(err)}`) as HermesHttpError;
    fetchErr.code = "hermes_gateway_connect_failed";
    throw fetchErr;
  }
  const body = await readResponseJson(response);
  if (!response.ok) {
    const classified = classifyHttpError(response.status);
    const err = new Error(`Hermes gateway HTTP ${response.status}`) as HermesHttpError;
    err.status = response.status;
    err.code = classified.code;
    err.retryNotBefore = response.headers.get("retry-after");
    err.body = body;
    throw err;
  }
  return body;
}

function extractRunId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.run_id) ?? nonEmpty(record?.runId) ?? nonEmpty(record?.id);
}

function eventNameFromData(data: unknown, fallback: string | null): string | null {
  const record = asRecord(data);
  return nonEmpty(record?.event) ?? nonEmpty(record?.type) ?? fallback;
}

function parseJsonData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

export function parseSseFramesForTest(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let offset = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", offset);
    if (idx < 0) break;
    const rawFrame = normalized.slice(offset, idx);
    offset = idx + 2;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest: normalized.slice(offset) };
}

function createExecutionState(runId: string): ExecutionState {
  let resolveTerminal!: (state: TerminalState) => void;
  const terminalPromise = new Promise<TerminalState>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    runId,
    outputChunks: [],
    lastEventName: null,
    terminal: null,
    resolveTerminal,
    terminalPromise,
  };
}

function markTerminal(state: ExecutionState, terminal: TerminalState): void {
  if (state.terminal) return;
  state.terminal = terminal;
  state.resolveTerminal(terminal);
}

function extractStatus(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.status)?.toLowerCase() ?? null;
}

function extractOutput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const direct =
    nonEmpty(record.output) ??
    nonEmpty(record.result) ??
    nonEmpty(record.text) ??
    nonEmpty(record.summary) ??
    nonEmpty(record.message);
  if (direct) return direct;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? extractOutput(nested) : null;
}

async function handleEvent(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  frame: SseFrame,
  redactText: TextRedactor = sanitizeSensitiveText,
): Promise<void> {
  const parsed = parseJsonData(frame.data);
  const record = asRecord(parsed);
  const eventName = eventNameFromData(parsed, frame.event);
  state.lastEventName = eventName;
  await ctx.onLog(
    "stdout",
    `[hermes-gateway:event] run=${state.runId} event=${eventName ?? "message"} data=${stringifyForLog(redactForLog(parsed, [], 0, redactText), 8_000)}\n`,
  );

  const delta = nonEmpty(record?.delta) ?? nonEmpty(record?.text_delta);
  if (eventName === "message.delta" && delta) {
    const sanitizedDelta = redactText(delta);
    state.outputChunks.push(sanitizedDelta);
    await ctx.onLog("stdout", sanitizedDelta);
  }

  const status = extractStatus(parsed) ?? (eventName?.startsWith("run.") ? eventName.slice(4) : null);
  if (status && TERMINAL_STATUSES.has(status)) {
    markTerminal(state, {
      runId: state.runId,
      status,
      eventName,
      payload: record,
      output: extractOutput(parsed),
    });
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function pollStatus(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  intervalMs: number;
  redactText?: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    await delay(input.intervalMs, input.signal);
    if (input.signal.aborted || input.state.terminal) break;
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) {
        markTerminal(input.state, {
          runId: input.state.runId,
          status: normalized,
          payload: asRecord(status),
          output: extractOutput(status),
        });
      }
    } catch (err) {
      if (input.signal.aborted) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] status poll failed: ${redactErrorMessage(err, input.redactText)}\n`);
    }
  }
}

async function consumeEvents(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  reconnectMs: number;
  redactText?: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    try {
      const response = await fetch(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}/events`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      if (!response.ok) {
        await input.ctx.onLog("stderr", `[hermes-gateway] event stream HTTP ${response.status}; falling back to polling\n`);
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      if (!response.body) {
        await input.ctx.onLog("stderr", "[hermes-gateway] event stream response had no body; falling back to polling\n");
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted && !input.state.terminal) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            const parsed = parseSseFramesForTest(`${buffer}\n\n`);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              await handleEvent(input.ctx, input.state, frame, input.redactText);
              if (input.state.terminal) break;
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFramesForTest(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          await handleEvent(input.ctx, input.state, frame, input.redactText);
          if (input.state.terminal) break;
        }
      }
    } catch (err) {
      if (input.signal.aborted || input.state.terminal) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] event stream disconnected: ${redactErrorMessage(err, input.redactText)}\n`);
    }
    if (!input.state.terminal) await delay(input.reconnectMs, input.signal);
  }
}

function parseUsage(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = asRecord(record.usage) ?? record;
  const inputTokens = asNumber(source.input_tokens ?? source.inputTokens ?? source.input, 0);
  const outputTokens = asNumber(source.output_tokens ?? source.outputTokens ?? source.output, 0);
  const cachedInputTokens = asNumber(source.cached_input_tokens ?? source.cachedInputTokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function parseCostUsd(value: unknown): number | null {
  const record = asRecord(value);
  const raw = record?.cost_usd ?? record?.costUsd ?? asRecord(record?.usage)?.cost_usd ?? asRecord(record?.usage)?.costUsd;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSessionId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.session_id) ?? nonEmpty(record?.sessionId) ?? nonEmpty(asRecord(record?.data)?.session_id);
}

function extractModel(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.model) ?? nonEmpty(asRecord(record?.usage)?.model);
}

function extractErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.error) ?? nonEmpty(record?.message) ?? nonEmpty(record?.detail) ?? extractOutput(value);
}

function terminalResultCode(status: string): { exitCode: number; signal: string | null; errorCode: string | null } {
  if (status === "completed") return { exitCode: 0, signal: null, errorCode: null };
  if (FAILURE_STATUSES.has(status)) return { exitCode: 1, signal: null, errorCode: "hermes_gateway_run_failed" };
  if (CANCELLED_STATUSES.has(status)) return { exitCode: 1, signal: "SIGTERM", errorCode: "hermes_gateway_cancelled" };
  return { exitCode: 1, signal: null, errorCode: "hermes_gateway_protocol_error" };
}

export function mapFinalResultForTest(input: {
  terminal: TerminalState;
  outputChunks: string[];
  sessionKey: string | null;
  strategy: SessionKeyStrategy;
  redactText?: TextRedactor;
}): AdapterExecutionResult {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  const payload = input.terminal.payload ?? {};
  const output = redactText(
    input.terminal.output ?? extractOutput(payload) ?? input.outputChunks.join("").trim(),
  );
  const sessionId = extractSessionId(payload) ?? input.sessionKey;
  const sessionDisplayId = sessionId ? redactText(sessionId) : null;
  const mapped = terminalResultCode(input.terminal.status);
  const usage = parseUsage(payload);
  const costUsd = parseCostUsd(payload);
  const errorMessage = mapped.errorCode
    ? redactText(extractErrorMessage(payload) ?? `Hermes run ${input.terminal.status}`)
    : null;
  return {
    exitCode: mapped.exitCode,
    signal: mapped.signal,
    timedOut: false,
    provider: "hermes_gateway",
    model: extractModel(payload),
    ...(mapped.errorCode ? { errorCode: mapped.errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(output ? { summary: output.slice(0, 2_000) } : {}),
    sessionId: sessionDisplayId,
    sessionParams: {
      hermesRunId: input.terminal.runId,
      ...(sessionId && sessionDisplayId === sessionId ? { hermesSessionId: sessionId } : {}),
      strategy: input.strategy,
    },
    sessionDisplayId,
    resultJson: {
      run_id: input.terminal.runId,
      status: input.terminal.status,
      session_id: sessionDisplayId,
      last_event: input.terminal.eventName ?? null,
      output: output ?? "",
      usage: usage ?? null,
      cost_usd: costUsd,
    },
  };
}

async function stopRun(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  redactText?: TextRedactor;
}): Promise<Record<string, unknown> | null> {
  try {
    const stopped = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/stop`), {
      method: "POST",
      headers: input.headers,
    });
    await input.ctx.onLog("stdout", `[hermes-gateway] stop requested for run ${input.runId}\n`);
    return asRecord(stopped);
  } catch (err) {
    await input.ctx.onLog("stderr", `[hermes-gateway] stop request failed: ${redactErrorMessage(err, input.redactText)}\n`);
    return null;
  }
}

async function fetchFinalStatus(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineMs: number;
}): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + input.deadlineMs;
  while (Date.now() < deadline) {
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}`), {
        method: "GET",
        headers: input.headers,
      });
      const record = asRecord(status);
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) return record;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function redactErrorMessage(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): string {
  if (err instanceof Error) return redactText(err.message);
  return redactText(String(err));
}

function errorResult(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): AdapterExecutionResult {
  const hermesError = err as HermesHttpError;
  const code = hermesError.code ?? "hermes_gateway_protocol_error";
  const classified = hermesError.status ? classifyHttpError(hermesError.status) : null;
  const errorMessage = code === "hermes_gateway_auth_failed"
    ? `${redactErrorMessage(err, redactText)}. Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY for the running gateway.`
    : redactErrorMessage(err, redactText);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: code,
    errorFamily: classified?.family ?? (code === "hermes_gateway_connect_failed" ? "transient_upstream" : null),
    retryNotBefore: hermesError.retryNotBefore ?? null,
    errorMessage,
    errorMeta: {
      ...(hermesError.status ? { status: hermesError.status } : {}),
      ...(hermesError.body ? { body: redactForLog(hermesError.body, [], 0, redactText) as Record<string, unknown> } : {}),
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const apiBaseUrlValue = asString(ctx.config.apiBaseUrl ?? ctx.config.url, "").trim();
  if (!apiBaseUrlValue) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_missing",
      errorMessage: "Hermes gateway adapter requires apiBaseUrl.",
    };
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrlValue);
  if (!baseUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_base_url_invalid",
      errorMessage: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
    };
  }
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(baseUrl.hostname),
    };
  }

  const apiKey = nonEmpty(ctx.config.apiKey) ?? nonEmpty(ctx.config.token);
  if (!apiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_api_key_missing",
      errorMessage: "Hermes gateway adapter requires apiKey.",
    };
  }

  const timeoutSec = parseNonNegativeNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutMs = timeoutSec > 0 ? Math.ceil(timeoutSec * 1000) : 0;
  const reconnectMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS), 250, 30_000));
  const pollIntervalMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS), 250, 10_000));
  const strategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const sessionKey = resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId: issueIdFromContext(ctx),
  });
  const extraHeaders = parseHeaders(ctx.config.headers);
  const runHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "application/json",
    contentType: "application/json",
  });
  const eventHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "text/event-stream",
  });
  const redactText = createTextRedactor([
    apiKey,
    sessionKey,
    runHeaders.Authorization,
    runHeaders["X-Hermes-Session-Key"],
  ]);
  const body = buildRunBody(ctx, sessionKey);
  const createRunUrl = apiUrl(baseUrl, "/v1/runs");

  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: "POST /v1/runs",
    commandArgs: [createRunUrl],
    context: {
      runId: ctx.runId,
      timeoutSec,
      eventReconnectMs: reconnectMs,
      sessionKeyStrategy: strategy,
      hasSessionKey: Boolean(sessionKey),
    },
  });
  await ctx.onLog("stdout", `[hermes-gateway] creating run at ${createRunUrl} (timeout=${timeoutSec}s, session=${strategy})\n`);
  await ctx.onLog("stdout", `[hermes-gateway] request headers (redacted): ${stringifyForLog(redactForLog(runHeaders, [], 0, redactText), 3_000)}\n`);

  let runId: string | null = null;
  try {
    const created = await fetchJson(createRunUrl, {
      method: "POST",
      headers: runHeaders,
      body: JSON.stringify(body),
    });
    runId = extractRunId(created);
    if (!runId) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "hermes_gateway_protocol_error",
        errorMessage: "Hermes /v1/runs response did not include run_id.",
        errorMeta: { response: redactForLog(created, [], 0, redactText) as Record<string, unknown> },
      };
    }
  } catch (err) {
    return errorResult(err, redactText);
  }

  await ctx.onLog("stdout", `[hermes-gateway] run created: ${runId}\n`);

  const state = createExecutionState(runId);
  const controller = new AbortController();
  void consumeEvents({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    reconnectMs,
    redactText,
  }).catch(() => undefined);
  void pollStatus({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    intervalMs: pollIntervalMs,
    redactText,
  }).catch(() => undefined);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    if (timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const outcome = await Promise.race([state.terminalPromise, timeoutPromise]);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  controller.abort();

  if (outcome === "timeout") {
    await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, redactText });
    const finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineMs: STOP_GRACE_MS });
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorCode: "hermes_gateway_timeout",
      errorMessage: `Hermes gateway run timed out after ${timeoutSec}s.`,
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: extractStatus(finalStatus) ?? "timeout",
        last_event: state.lastEventName,
        final_status: redactForLog(finalStatus, [], 0, redactText),
      },
      sessionParams: {
        hermesRunId: runId,
        strategy,
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
    };
  }

  return mapFinalResultForTest({
    terminal: outcome,
    outputChunks: state.outputChunks,
    sessionKey,
    strategy,
    redactText,
  });
}

import { WebSocket } from "ws";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeServiceReport,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  parseObject,
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
  timer: ReturnType<typeof setTimeout> | null;
};

const REMOTE_URL_HINT =
  "Set adapterConfig.agentSdkServerUrl to a ws:// or wss:// Paperclip Claude SDK server endpoint.";

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

function resolveClaudeSdkServerConfig(config: Record<string, unknown>) {
  const url = nonEmpty(config.agentSdkServerUrl) ?? nonEmpty(config.sdkServerUrl);
  const headers = parseHeaderConfig(config.agentSdkServerHeaders);
  const bearerToken = nonEmpty(config.agentSdkServerBearerToken);
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  return { url, headers, bearerToken };
}

function stripClaudeSdkServerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config };
  delete next.agentSdkServerUrl;
  delete next.sdkServerUrl;
  delete next.agentSdkServerHeaders;
  delete next.agentSdkServerBearerToken;
  return next;
}

function isRemoteClaudeSdkConfig(config: Record<string, unknown>): boolean {
  return Boolean(resolveClaudeSdkServerConfig(config).url);
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

function createTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function parseUsage(value: unknown): UsageSummary | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  return {
    inputTokens: asNumber(usage.inputTokens, asNumber(usage.input_tokens, 0)),
    cachedInputTokens: asNumber(
      usage.cachedInputTokens,
      asNumber(usage.cached_input_tokens, asNumber(usage.cache_read_input_tokens, 0)),
    ),
    outputTokens: asNumber(usage.outputTokens, asNumber(usage.output_tokens, 0)),
  };
}

function parseRuntimeServices(value: unknown): AdapterRuntimeServiceReport[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const services = value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      id: nonEmpty(entry.id),
      projectId: nonEmpty(entry.projectId),
      projectWorkspaceId: nonEmpty(entry.projectWorkspaceId),
      issueId: nonEmpty(entry.issueId),
      scopeType:
        entry.scopeType === "project_workspace" ||
        entry.scopeType === "execution_workspace" ||
        entry.scopeType === "run" ||
        entry.scopeType === "agent"
          ? entry.scopeType
          : undefined,
      scopeId: nonEmpty(entry.scopeId),
      serviceName: asString(entry.serviceName, ""),
      status:
        entry.status === "starting" ||
        entry.status === "running" ||
        entry.status === "stopped" ||
        entry.status === "failed"
          ? entry.status
          : undefined,
      lifecycle: entry.lifecycle === "shared" || entry.lifecycle === "ephemeral" ? entry.lifecycle : undefined,
      reuseKey: nonEmpty(entry.reuseKey),
      command: nonEmpty(entry.command),
      cwd: nonEmpty(entry.cwd),
      port: typeof entry.port === "number" && Number.isFinite(entry.port) ? entry.port : undefined,
      url: nonEmpty(entry.url),
      providerRef: nonEmpty(entry.providerRef),
      ownerAgentId: nonEmpty(entry.ownerAgentId),
      stopPolicy: asRecord(entry.stopPolicy),
      healthStatus:
        entry.healthStatus === "unknown" ||
        entry.healthStatus === "healthy" ||
        entry.healthStatus === "unhealthy"
          ? entry.healthStatus
          : undefined,
    } satisfies AdapterRuntimeServiceReport))
    .filter((service) => service.serviceName.length > 0);
  return services.length > 0 ? services : undefined;
}

function normalizeRemoteExecutionResult(
  raw: unknown,
  fallback: { model: string | null },
): AdapterExecutionResult {
  const result = asRecord(raw);
  if (!result) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude SDK server returned an invalid result payload",
      provider: "anthropic",
      model: fallback.model,
      billingType: "unknown",
      costUsd: null,
      clearSession: false,
    };
  }

  const usage = parseUsage(result.usage);
  const sessionParams = asRecord(result.sessionParams);
  const resultJson = asRecord(result.resultJson);
  const billingTypeRaw = asString(result.billingType, "unknown");
  const billingType =
    billingTypeRaw === "api" ||
    billingTypeRaw === "subscription" ||
    billingTypeRaw === "metered_api" ||
    billingTypeRaw === "subscription_included" ||
    billingTypeRaw === "subscription_overage" ||
    billingTypeRaw === "credits" ||
    billingTypeRaw === "fixed" ||
    billingTypeRaw === "unknown"
      ? billingTypeRaw
      : "unknown";
  return {
    exitCode: typeof result.exitCode === "number" && Number.isFinite(result.exitCode) ? result.exitCode : 1,
    signal: nonEmpty(result.signal),
    timedOut: result.timedOut === true,
    errorMessage: result.errorMessage == null ? null : asString(result.errorMessage, ""),
    errorCode: result.errorCode == null ? null : asString(result.errorCode, ""),
    errorFamily: result.errorFamily === "transient_upstream" ? "transient_upstream" : null,
    retryNotBefore: result.retryNotBefore == null ? null : asString(result.retryNotBefore, ""),
    errorMeta: asRecord(result.errorMeta) ?? undefined,
    usage,
    sessionId: result.sessionId == null ? null : asString(result.sessionId, ""),
    sessionParams,
    sessionDisplayId: result.sessionDisplayId == null ? null : asString(result.sessionDisplayId, ""),
    provider: result.provider == null ? "anthropic" : asString(result.provider, "anthropic"),
    biller: result.biller == null ? null : asString(result.biller, ""),
    model: result.model == null ? fallback.model : asString(result.model, fallback.model ?? ""),
    billingType,
    costUsd: typeof result.costUsd === "number" && Number.isFinite(result.costUsd) ? result.costUsd : null,
    resultJson,
    runtimeServices: parseRuntimeServices(result.runtimeServices),
    summary: result.summary == null ? null : asString(result.summary, ""),
    clearSession: result.clearSession === true,
    question: result.question && typeof result.question === "object" ? (result.question as AdapterExecutionResult["question"]) : null,
  };
}

class ClaudeSdkServerClient {
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
        reject(createTimeoutError(`Timed out connecting to Claude SDK server after ${timeoutMs}ms`));
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
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error(`Claude SDK server connection closed while waiting for request ${String(id)}`));
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
    }, 5_000);
  }

  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer =
        typeof timeoutMs === "number" && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(createTimeoutError(`Timed out waiting for Claude SDK server response to ${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send(payload);
    });
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
      throw new Error("Claude SDK server WebSocket is not open");
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
    if (pending.timer) clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new Error(nonEmpty(response.error.message) ?? `Claude SDK server request ${String(response.id)} failed`));
      return;
    }
    pending.resolve(response.result);
  }
}

export async function executeClaudeViaSdkServer(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, onLog, onMeta, onSpawn, authToken, runtime, context, runId, agent } = ctx;
  const { url, headers } = resolveClaudeSdkServerConfig(config);
  const model = nonEmpty(config.model);
  if (!url) throw new Error("Claude SDK server execution requires adapterConfig.agentSdkServerUrl");

  const remoteConfig = stripClaudeSdkServerConfig(config);
  const remoteAgent = {
    ...agent,
    adapterConfig: stripClaudeSdkServerConfig(parseObject(agent.adapterConfig)),
  };

  if (onMeta) {
    await onMeta({
      adapterType: "claude_local",
      command: "paperclip-claude-sdk-server",
      cwd: nonEmpty(remoteConfig.cwd) ?? undefined,
      commandArgs: [url],
      commandNotes: [
        `Using remote Paperclip Claude SDK server over WebSocket: ${url}`,
        "The remote bridge is expected to run Claude locally on its own host and stream stdout/stderr back to Paperclip.",
        ...(Object.keys(headers).length > 0
          ? [`Configured ${Object.keys(headers).length} WebSocket header(s) for the bridge handshake.`]
          : []),
      ],
      context,
    });
  }

  const client = new ClaudeSdkServerClient(
    url,
    headers,
    async (message) => {
      const params = asRecord(message.params) ?? {};
      switch (message.method) {
        case "run/log": {
          const stream = asString(params.stream, "stdout") === "stderr" ? "stderr" : "stdout";
          const chunk = asString(params.chunk, "");
          if (chunk) await onLog(stream, chunk);
          return;
        }
        case "run/spawn": {
          if (!onSpawn) return;
          const pid = typeof params.pid === "number" && Number.isFinite(params.pid) ? params.pid : null;
          if (pid == null) return;
          const processGroupId =
            typeof params.processGroupId === "number" && Number.isFinite(params.processGroupId)
              ? params.processGroupId
              : null;
          const startedAt = asString(params.startedAt, new Date().toISOString());
          await onSpawn({ pid, processGroupId, startedAt });
          return;
        }
        default:
          return;
      }
    },
    async (message) => {
      client.respondError(
        message.id,
        `Paperclip does not support interactive Claude SDK server request ${message.method}.`,
      );
      await onLog("stderr", `[paperclip] Unsupported Claude SDK server request: ${message.method}\n`);
    },
  );

  try {
    await client.connect(15_000);
    await client.initialize();
    const timeoutMs =
      typeof remoteConfig.timeoutSec === "number" && Number.isFinite(remoteConfig.timeoutSec) && remoteConfig.timeoutSec > 0
        ? Math.max(1, Math.floor(remoteConfig.timeoutSec)) * 1000 + 30_000
        : undefined;
    const result = await client.request("run/execute", {
      runId,
      agent: remoteAgent,
      runtime,
      config: remoteConfig,
      context,
      authToken: authToken ?? null,
    }, timeoutMs);
    return normalizeRemoteExecutionResult(result, { model });
  } catch (err) {
    const message = toErrorMessage(err, "Claude SDK server execution failed");
    return {
      exitCode: 1,
      signal: null,
      timedOut: err instanceof Error && err.name === "TimeoutError",
      errorMessage: message,
      provider: "anthropic",
      model,
      billingType: "unknown",
      costUsd: null,
      clearSession: false,
    };
  } finally {
    await client.close();
  }
}

export async function testClaudeSdkServerEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const { url, headers, bearerToken } = resolveClaudeSdkServerConfig(config);

  if (!url) {
    checks.push({
      code: "claude_sdk_server_url_missing",
      level: "error",
      message: "Claude remote mode requires adapterConfig.agentSdkServerUrl.",
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
      code: "claude_sdk_server_url_invalid",
      level: "error",
      message: `Invalid Claude SDK server URL: ${url}`,
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
    code: "claude_sdk_server_url_valid",
    level: "info",
    message: `Configured Claude SDK server endpoint: ${parsedUrl.toString()}`,
  });

  if (parsedUrl.protocol === "ws:" && !isLoopbackHost(parsedUrl.hostname)) {
    checks.push({
      code: "claude_sdk_server_plaintext_remote_ws",
      level: "warn",
      message: "Claude SDK server URL uses plaintext ws:// on a non-loopback host.",
      hint: "Prefer wss:// or SSH port forwarding for remote Claude SDK bridges.",
    });
  }

  if (Object.keys(headers).length > 0) {
    checks.push({
      code: "claude_sdk_server_headers_present",
      level: "info",
      message: `Configured ${Object.keys(headers).length} WebSocket header(s) for remote Claude auth.`,
    });
  } else if (!isLoopbackHost(parsedUrl.hostname)) {
    checks.push({
      code: "claude_sdk_server_remote_auth_missing",
      level: "warn",
      message: "No remote Claude SDK bridge auth headers are configured.",
      hint: "Prefer a loopback listener over SSH, or configure bearer/header auth for externally reachable bridges.",
    });
  }

  if (bearerToken) {
    checks.push({
      code: "claude_sdk_server_bearer_token_present",
      level: "info",
      message: "Configured a bearer token for the Claude SDK server WebSocket handshake.",
    });
  }

  const client = new ClaudeSdkServerClient(parsedUrl.toString(), headers, async () => {}, async (message) => {
    client.respondError(message.id, `Unsupported request during environment test: ${message.method}`);
  });

  try {
    await client.connect(5_000);
    checks.push({
      code: "claude_sdk_server_connect_ok",
      level: "info",
      message: "Connected to Claude SDK server.",
    });

    await client.initialize();
    checks.push({
      code: "claude_sdk_server_initialize_ok",
      level: "info",
      message: "Claude SDK server initialize handshake succeeded.",
    });

    const health = asRecord(await client.request("health/check", {}, 5_000));
    const bridgeName = nonEmpty(health?.bridge) ?? nonEmpty(health?.name);
    if (bridgeName) {
      checks.push({
        code: "claude_sdk_server_health_ok",
        level: "info",
        message: `Remote Claude bridge responded to health check (${bridgeName}).`,
      });
    } else {
      checks.push({
        code: "claude_sdk_server_health_ok",
        level: "info",
        message: "Remote Claude bridge responded to health check.",
      });
    }
    if (health?.authConfigured === false) {
      checks.push({
        code: "claude_sdk_server_auth_missing",
        level: "warn",
        message: "Remote Claude bridge reports that Claude authentication is not configured.",
        hint: "Authenticate Claude on the remote host before using this bridge.",
      });
    }
  } catch (err) {
    checks.push({
      code: "claude_sdk_server_probe_failed",
      level: "error",
      message: toErrorMessage(err, "Failed to reach Claude SDK server"),
      hint: "Verify the WebSocket URL, auth headers, and remote Claude SDK bridge listener configuration.",
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

export { isRemoteClaudeSdkConfig };

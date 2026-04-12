import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function buildHeaders(config: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const authHeader = asString(config.authHeader, "").trim();
  if (authHeader) {
    headers["authorization"] = authHeader;
  }

  const customHeaders = parseObject(config.headers);
  for (const [key, value] of Object.entries(customHeaders)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }

  return headers;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta } = ctx;

  const endpoint = asString(config.endpoint, "").replace(/\/+$/, "");
  if (!endpoint) throw new Error("http_agent adapter missing endpoint");

  const promptPath = asString(config.promptEndpoint, "/api/prompt");
  const method = asString(config.method, "POST").toUpperCase();
  const timeoutSec = asNumber(config.timeoutSec, 120);
  const timeoutMs = timeoutSec * 1000;
  const resultPath = asString(config.resultPath, "result");
  const statusPath = asString(config.statusPath, "status");
  const errorPath = asString(config.errorPath, "error");
  const headers = buildHeaders(config);

  // Build payload
  const payloadTemplate = parseObject(config.payloadTemplate);
  const paperclipEnv = buildPaperclipEnv(agent);
  const taskContext: Record<string, unknown> = {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    agentName: agent.name,
  };
  if (ctx.context.issueId) taskContext.issueId = ctx.context.issueId;
  if (ctx.context.taskId) taskContext.taskId = ctx.context.taskId;
  if (ctx.context.wakeReason) taskContext.wakeReason = ctx.context.wakeReason;

  const payload = {
    ...payloadTemplate,
    context: taskContext,
    paperclipEnv,
  };

  const url = `${endpoint}${promptPath}`;

  if (onMeta) {
    await onMeta({
      adapterType: "http_agent",
      command: `${method} ${url}`,
      commandArgs: [],
      env: {},
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method !== "GET" ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `HTTP ${method} ${url} failed with status ${res.status}: ${body.slice(0, 500)}`,
      };
    }

    const data = await res.json().catch(() => ({}));

    // Check for errors in response
    const errorValue = getNestedValue(data, errorPath);
    if (errorValue) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Remote agent error: ${typeof errorValue === "string" ? errorValue : JSON.stringify(errorValue)}`,
        resultJson: data,
      };
    }

    // Log output if available
    const result = getNestedValue(data, resultPath);
    if (result && onLog) {
      await onLog("stdout", typeof result === "string" ? result : JSON.stringify(result, null, 2));
    }

    // Check status
    const status = getNestedValue(data, statusPath);
    const isFailed = typeof status === "string" && (status === "failed" || status === "error");

    return {
      exitCode: isFailed ? 1 : 0,
      signal: null,
      timedOut: false,
      resultJson: data,
      summary: typeof result === "string" ? result.slice(0, 200) : undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: true,
        errorMessage: `Request timed out after ${timeoutSec}s`,
      };
    }
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: err instanceof Error ? err.message : "HTTP request failed",
    };
  }
}

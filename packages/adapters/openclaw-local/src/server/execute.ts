import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_ENDPOINT = "http://localhost:18789";

interface OpenClawSessionResponse {
  sessionId?: string;
  id?: string;
  status?: string;
  error?: string;
}

interface OpenClawResultResponse {
  status?: string;
  output?: string;
  result?: string;
  error?: string;
  done?: boolean;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (norm === "true" || norm === "1") return true;
    if (norm === "false" || norm === "0") return false;
  }
  return fallback;
}

function buildHeaders(config: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const authToken = asString(config.authToken, "").trim();
  if (authToken) {
    headers["authorization"] = authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`;
  }
  return headers;
}

async function startSession(
  endpoint: string,
  headers: Record<string, string>,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<OpenClawSessionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { error: `Session start failed: HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    return await res.json() as OpenClawSessionResponse;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Session start failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function pollResults(
  endpoint: string,
  headers: Record<string, string>,
  sessionId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ output: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let output = "";

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${endpoint}/api/sessions/${encodeURIComponent(sessionId)}/result`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json() as OpenClawResultResponse;
        if (data.output) {
          output += data.output;
          if (onLog) await onLog("stdout", data.output);
        }
        if (data.result) {
          output += data.result;
          if (onLog) await onLog("stdout", data.result);
        }
        if (data.done || data.status === "completed" || data.status === "failed") {
          if (data.error) {
            return { output, error: data.error };
          }
          return { output };
        }
      }
    } catch (err) {
      clearTimeout(timer);
      // Continue polling on transient errors
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { output, error: `Polling timed out after ${timeoutMs}ms` };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta } = ctx;

  const endpoint = asString(config.endpoint, DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const agentType = asString(config.agentType, "main");
  const sessionKey = asString(config.sessionKey, `paperclip:${runId}`);
  const timeoutSec = asNumber(config.timeoutSec, 120);
  const pollIntervalMs = asNumber(config.pollIntervalMs, 1000);
  const timeoutMs = timeoutSec * 1000;
  const headers = buildHeaders(config);

  // Build task context
  const taskContext: Record<string, unknown> = {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    agentName: agent.name,
  };
  if (ctx.context.issueId) taskContext.issueId = ctx.context.issueId;
  if (ctx.context.taskId) taskContext.taskId = ctx.context.taskId;
  if (ctx.context.wakeReason) taskContext.wakeReason = ctx.context.wakeReason;

  // Build session params
  const payloadTemplate = parseObject(config.payloadTemplate);
  const sessionParams = {
    ...payloadTemplate,
    agentType,
    sessionKey,
    context: taskContext,
    paperclipEnv: buildPaperclipEnv(agent),
  };

  if (onMeta) {
    await onMeta({
      adapterType: "openclaw_local",
      command: `${endpoint}/api/sessions`,
      cwd: undefined,
      commandArgs: [],
      env: {},
    });
  }

  // Start session
  const session = await startSession(endpoint, headers, sessionParams, 10_000);
  if (session.error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: session.error,
    };
  }

  const sessionId = session.sessionId ?? session.id ?? "";
  if (!sessionId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw did not return a session ID",
    };
  }

  if (onLog) await onLog("stdout", `OpenClaw session started: ${sessionId}\n`);

  // Poll for results
  const result = await pollResults(
    endpoint,
    headers,
    sessionId,
    timeoutMs,
    pollIntervalMs,
    onLog,
  );

  if (result.error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: result.error,
      resultJson: {
        sessionId,
        output: result.output,
      },
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    resultJson: {
      sessionId,
      output: result.output,
    },
  };
}

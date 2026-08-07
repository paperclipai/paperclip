import type { AdapterExecutionContext, AdapterExecutionResult, UsageSummary } from "../types.js";
import { asString, asNumber, parseObject, renderTemplate } from "../utils.js";

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_MAX_ATTEMPTS = 90;
const DEFAULT_TERMINAL_STATUSES = ["completed", "failed", "succeeded", "error", "cancelled"];
const FAILURE_STATUSES = ["failed", "error", "cancelled"];
const DEFAULT_RUN_ID_PATH = "run_id";
const DEFAULT_STATUS_PATH = "status";
const DEFAULT_OUTPUT_PATH = "output";
const DEFAULT_USAGE_PATH = "usage";

interface PollConfig {
  urlTemplate: string;
  intervalMs: number;
  maxAttempts: number;
  terminalStatuses: string[];
  runIdPath: string;
  statusPath: string;
  outputPath: string;
  usagePath: string;
  outputAsSummary: boolean;
  costUsdPath?: string;
  modelPath?: string;
  providerPath?: string;
}

function readPollConfig(config: Record<string, unknown>): PollConfig | null {
  const raw = parseObject(config.poll);
  if (!raw || raw.enabled !== true) return null;

  const urlTemplate = asString(raw.urlTemplate, "");
  if (!urlTemplate) return null;

  const terminalStatusesRaw: unknown = raw.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES;
  const terminalStatuses = Array.isArray(terminalStatusesRaw)
    ? terminalStatusesRaw.map((status) => String(status).toLowerCase())
    : DEFAULT_TERMINAL_STATUSES;

  return {
    urlTemplate,
    intervalMs: asNumber(raw.intervalMs, DEFAULT_POLL_INTERVAL_MS),
    maxAttempts: asNumber(raw.maxAttempts, DEFAULT_POLL_MAX_ATTEMPTS),
    terminalStatuses,
    runIdPath: asString(raw.runIdPath, DEFAULT_RUN_ID_PATH),
    statusPath: asString(raw.statusPath, DEFAULT_STATUS_PATH),
    outputPath: asString(raw.outputPath, DEFAULT_OUTPUT_PATH),
    usagePath: asString(raw.usagePath, DEFAULT_USAGE_PATH),
    outputAsSummary: raw.outputAsSummary === true,
    costUsdPath: typeof raw.costUsdPath === "string" ? raw.costUsdPath : undefined,
    modelPath: typeof raw.modelPath === "string" ? raw.modelPath : undefined,
    providerPath: typeof raw.providerPath === "string" ? raw.providerPath : undefined,
  };
}

function readPath(source: unknown, path: string): unknown {
  if (!path || source === null || source === undefined) return undefined;
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

// Render every string in the payload template. Non-strings (numbers, booleans,
// null) pass through untouched, so `timeout_sec: 120` stays a number rather
// than becoming "120".
function renderPayloadValue(value: unknown, data: Record<string, unknown>): unknown {
  if (typeof value === "string") return renderTemplate(value, data);
  if (Array.isArray(value)) return value.map((entry) => renderPayloadValue(entry, data));
  if (value && typeof value === "object") {
    const rendered: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      rendered[key] = renderPayloadValue(entry, data);
    }
    return rendered;
  }
  return value;
}

function toUsageSummary(raw: unknown): UsageSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const input = Number(record.input_tokens ?? record.prompt_tokens ?? record.inputTokens ?? 0);
  const output = Number(record.output_tokens ?? record.completion_tokens ?? record.outputTokens ?? 0);
  const cached = Number(record.cached_input_tokens ?? record.cached_tokens ?? record.cachedInputTokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function stringifyOutput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, onLog } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;

  // Render the payload template against the same data shape the local adapters
  // use for promptTemplate, so a remote runtime can receive per-run context
  // (e.g. `input: "Work issue {{ context.issueId }}"`). Without this the payload
  // is static per agent and the remote runtime never learns which run it is on.
  const templateData: Record<string, unknown> = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    // Deliberately a narrow subset, NOT the whole agent record. This payload is
    // sent to a third-party endpoint and agent.adapterConfig can hold plaintext
    // credentials; renderTemplate JSON-stringifies objects, so exposing `agent`
    // wholesale would let a stray `{{ agent }}` ship those secrets off-box.
    agent: {
      id: agent.id,
      name: agent.name,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
    },
    run: { id: runId },
    context,
  };
  const payloadTemplate = renderPayloadValue(
    parseObject(config.payloadTemplate),
    templateData,
  ) as Record<string, unknown>;
  const body = {
    ...payloadTemplate,
    agentId: agent.id,
    runId,
    context,
    ...(ctx.runtimeTools ? { paperclipRuntimeTools: ctx.runtimeTools } : {}),
  };

  const pollConfig = readPollConfig(config);

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let initialResponseJson: unknown = null;
  try {
    // HTTP adapters have no child-process spawn event. Signal immediately
    // before starting the remote request so dispatch gates can release without
    // waiting for the endpoint to respond.
    ctx.onDispatch?.();
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    // Only the polling path needs the response body, but reading it
    // unconditionally keeps the fire-and-forget path's behavior identical.
    const responseText = await res.text();
    try {
      initialResponseJson = responseText ? JSON.parse(responseText) : null;
    } catch {
      initialResponseJson = responseText;
    }
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  // No poll block configured: preserve the historical fire-and-forget contract.
  if (!pollConfig) {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  }

  const remoteRunId = readPath(initialResponseJson, pollConfig.runIdPath);
  if (typeof remoteRunId !== "string" || remoteRunId.length === 0) {
    throw new Error(
      `HTTP adapter poll enabled but no run id at path "${pollConfig.runIdPath}" in the invoke response`,
    );
  }

  const pollUrl = renderTemplate(pollConfig.urlTemplate, {
    run_id: remoteRunId,
    runId: remoteRunId,
  });
  await onLog(
    "stderr",
    `[paperclip] http adapter dispatched run ${remoteRunId}; polling ${pollUrl} every ${pollConfig.intervalMs}ms\n`,
  );

  let lastStatus: string | null = null;
  let lastJson: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < pollConfig.maxAttempts; attempt++) {
    await sleep(pollConfig.intervalMs);

    const pollRes = await fetch(pollUrl, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
    });
    if (!pollRes.ok) {
      await onLog(
        "stderr",
        `[paperclip] poll attempt ${attempt + 1}/${pollConfig.maxAttempts} returned HTTP ${pollRes.status}; continuing\n`,
      );
      continue;
    }

    const pollText = await pollRes.text();
    let pollJson: Record<string, unknown> | null = null;
    try {
      pollJson = pollText ? (JSON.parse(pollText) as Record<string, unknown>) : null;
    } catch {
      await onLog("stderr", `[paperclip] poll response was not JSON; raw: ${pollText.slice(0, 200)}\n`);
      continue;
    }
    if (!pollJson) continue;

    lastJson = pollJson;
    const statusRaw = readPath(pollJson, pollConfig.statusPath);
    const status = typeof statusRaw === "string" ? statusRaw.toLowerCase() : null;
    if (status && status !== lastStatus) {
      await onLog("stderr", `[paperclip] run ${remoteRunId} status=${status}\n`);
      lastStatus = status;
    }
    if (status && pollConfig.terminalStatuses.includes(status)) break;
  }

  if (!lastJson) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      errorMessage: `Polled ${pollConfig.maxAttempts} times without a usable response`,
      summary: `HTTP ${method} ${url} (poll timed out)`,
    };
  }

  const finalStatusRaw = readPath(lastJson, pollConfig.statusPath);
  const finalStatus = typeof finalStatusRaw === "string" ? finalStatusRaw.toLowerCase() : null;
  const reachedTerminal = finalStatus !== null && pollConfig.terminalStatuses.includes(finalStatus);
  const isSuccess = reachedTerminal && !FAILURE_STATUSES.includes(finalStatus);

  const outputText = stringifyOutput(readPath(lastJson, pollConfig.outputPath));
  if (outputText !== null) {
    await onLog("stdout", outputText);
  }

  const usage = toUsageSummary(readPath(lastJson, pollConfig.usagePath));
  const costUsd = pollConfig.costUsdPath ? Number(readPath(lastJson, pollConfig.costUsdPath)) : undefined;
  const model = pollConfig.modelPath ? readPath(lastJson, pollConfig.modelPath) : undefined;
  const provider = pollConfig.providerPath ? readPath(lastJson, pollConfig.providerPath) : undefined;

  // A remote runtime's answer is otherwise stranded in the run transcript: the
  // server builds the run's issue comment from `resultJson.summary`, and
  // mergeHeartbeatRunResultJson fills that from the adapter's `summary` when the
  // remote did not supply one. Opting in here therefore routes the captured
  // output onto the issue through the existing comment path, with no change to
  // the heartbeat service. Off by default because a status line is the more
  // useful run summary when the output is large or machine-readable.
  const statusSummary = `HTTP ${method} ${url} → run ${remoteRunId} (${finalStatus ?? "unknown"})`;
  const summary =
    pollConfig.outputAsSummary && isSuccess && outputText && outputText.trim()
      ? outputText.trim()
      : statusSummary;

  return {
    exitCode: isSuccess ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage: isSuccess ? null : `Remote run finished with status ${finalStatus ?? "unknown"}`,
    summary,
    usage,
    costUsd: typeof costUsd === "number" && Number.isFinite(costUsd) ? costUsd : null,
    model: typeof model === "string" ? model : null,
    provider: typeof provider === "string" ? provider : null,
    resultJson: lastJson,
  };
}

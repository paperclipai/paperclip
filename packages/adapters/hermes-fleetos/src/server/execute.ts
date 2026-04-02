import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber, asStringArray, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { FleetOSClient, FleetOSClientError } from "../shared/fleetos-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const SECRET_KEY_RE = /(key|token|secret|password|authorization)/i;

/** Recursively sanitize objects — replace values whose key matches SECRET_KEY_RE with "***". */
function deepSanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(deepSanitize);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SECRET_KEY_RE.test(k) ? "***" : deepSanitize(v);
  }
  return result;
}

/** Best-effort callback — never allows rejection to abort the adapter run. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safeCallback(fn: (...args: any[]) => Promise<void> | void, ...args: any[]): Promise<void> {
  try {
    await fn(...args);
  } catch {
    // Telemetry callbacks must not abort execution
  }
}

/**
 * Parse hermes CLI stdout for structured result fields.
 *
 * TODO: Refine parsing once the hermes CLI output format is finalized.
 * Currently we do best-effort extraction of session id and token usage
 * from JSON lines embedded in stdout.
 */
function parseHermesOutput(stdout: string): {
  sessionId: string | null;
  model: string | null;
  summary: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
} {
  let sessionId: string | null = null;
  let model: string | null = null;
  let summary: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd = 0;

  // TODO: The hermes CLI may emit structured JSON lines — attempt to parse each line
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;

      // Extract session id if present
      if (typeof parsed.session_id === "string" && parsed.session_id.trim()) {
        sessionId = parsed.session_id.trim();
      }

      // Extract model
      if (typeof parsed.model === "string" && parsed.model.trim()) {
        model = parsed.model.trim();
      }

      // Extract usage
      if (typeof parsed.usage === "object" && parsed.usage !== null) {
        const usage = parsed.usage as Record<string, unknown>;
        if (typeof usage.input_tokens === "number") inputTokens += usage.input_tokens;
        if (typeof usage.output_tokens === "number") outputTokens += usage.output_tokens;
        if (typeof usage.cache_read_input_tokens === "number") {
          cachedInputTokens += usage.cache_read_input_tokens;
        }
      }

      // Extract cost
      if (typeof parsed.total_cost_usd === "number") {
        costUsd = parsed.total_cost_usd;
      }

      // Extract summary / result text
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        summary = parsed.result.trim();
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  return { sessionId, model, summary, inputTokens, outputTokens, cachedInputTokens, costUsd };
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta } = ctx;

  // ---- Read adapter config ----
  const fleetosUrl = asString(config.fleetosUrl, "");
  const apiKey = asString(config.apiKey, "");
  const containerId = asString(config.containerId, "");

  if (!fleetosUrl || !apiKey || !containerId) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "hermes_fleetos adapter requires fleetosUrl, apiKey, and containerId in adapter config",
      errorCode: "config_missing",
    };
  }

  const model = asString(config.model, "");
  const timeoutSec = asNumber(config.timeoutSec, 120);
  const envConfig = parseObject(config.env);

  // Security: hermesCommand is allowlisted to prevent arbitrary binary execution (CRITICAL)
  const ALLOWED_COMMANDS = new Set(["hermes", "/home/agent/hermes-agent/venv/bin/hermes"]);
  const rawHermesCommand = asString(config.hermesCommand, "hermes");
  const hermesCommand = ALLOWED_COMMANDS.has(rawHermesCommand) ? rawHermesCommand : "hermes";

  // Security: hermesArgs are filtered — block dangerous flags (HIGH)
  const BLOCKED_ARG_PREFIXES = ["--exec", "--shell", "--eval", "--run-command", "-c"];
  const rawHermesArgs = asStringArray(config.hermesArgs);
  const hermesArgs = rawHermesArgs.filter(
    (arg) => !BLOCKED_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix)),
  );
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your assigned work.",
  );

  // Security: validate containerId format (MEDIUM)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(containerId)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Invalid containerId format",
      errorCode: "config_invalid",
    };
  }

  // ---- Build environment variables for container exec ----
  const execEnv: Record<string, string> = {};
  execEnv.RAAVA_AGENT_ID = agent.id;
  execEnv.RAAVA_COMPANY_ID = agent.companyId;
  execEnv.RAAVA_RUN_ID = runId;

  // Security: prefix-based allowlist for env vars (MEDIUM)
  const ALLOWED_ENV_PREFIXES = ["RAAVA_", "HERMES_", "OPENROUTER_", "DISCORD_"];
  for (const [key, value] of Object.entries(envConfig)) {
    if (
      typeof value === "string" &&
      ALLOWED_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))
    ) {
      execEnv[key] = value;
    }
  }

  // ---- Build the hermes CLI command ----
  // TODO: Refine prompt injection and template rendering once hermes CLI interface is stable
  const prompt = promptTemplate
    .replace(/\{\{agent\.id\}\}/g, agent.id)
    .replace(/\{\{agent\.name\}\}/g, agent.name ?? "");

  const command: string[] = [hermesCommand, "--print", "-"];
  if (model) command.push("--model", model);
  if (hermesArgs.length > 0) command.push(...hermesArgs);

  // The prompt is passed via stdin to the hermes CLI; we append it as the last positional arg
  // TODO: Determine if hermes accepts prompt via stdin or positional arg
  // Security: use "--" to prevent prompt from being interpreted as CLI flags (MEDIUM)
  command.push("--");
  command.push(prompt);

  // ---- Report invocation metadata ----
  if (onMeta) {
    // Security: parse debugMetadata as strict boolean to prevent truthy bypass
    const debug = config.debugMetadata === true || config.debugMetadata === "true";

    const safePrompt = debug
      ? prompt
      : `[redacted: ${prompt.length} chars]`;

    // Security: recursive sanitizer for nested secret keys (e.g., auth.token)
    const safeContext = debug ? context : deepSanitize(context);

    // Best-effort: telemetry callback must not abort the adapter run
    await safeCallback(onMeta, {
      adapterType: "hermes_fleetos",
      command: `fleetos:${containerId}/${hermesCommand}`,
      commandArgs: command.slice(1),
      env: deepSanitize(execEnv) as Record<string, unknown>,
      prompt: safePrompt,
      context: safeContext,
    });
  }

  // ---- Execute via FleetOS ----
  const client = new FleetOSClient(fleetosUrl, apiKey);
  const timeoutMs = timeoutSec * 1000;

  try {
    // Verify container is running before exec
    const container = await client.getContainer(containerId);
    if (container.status !== "running") {
      await safeCallback(onLog, "stderr", `[fleetos] Container ${containerId} is ${container.status}, attempting start...\n`);
      try {
        await client.startContainer(containerId);
        await safeCallback(onLog, "stdout", `[fleetos] Container ${containerId} started.\n`);
      } catch (startErr) {
        const reason = startErr instanceof Error ? startErr.message : String(startErr);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: `Container ${containerId} is ${container.status} and could not be started: ${reason}`,
          errorCode: "container_not_running",
        };
      }
    }

    await safeCallback(onLog, "stdout", `[fleetos] Executing hermes in container ${containerId}...\n`);

    const result = await client.exec(containerId, command, timeoutMs, execEnv);

    // Stream logs back (best-effort — never abort on callback failure)
    if (result.stdout) {
      await safeCallback(onLog, "stdout", result.stdout);
    }
    if (result.stderr) {
      await safeCallback(onLog, "stderr", result.stderr);
    }

    // ---- Parse hermes output ----
    const parsed = parseHermesOutput(result.stdout);

    if (result.timed_out) {
      return {
        exitCode: result.exit_code,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }

    if (result.exit_code !== 0 && !parsed.summary) {
      const stderrLine = result.stderr
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean);
      return {
        exitCode: result.exit_code,
        signal: null,
        timedOut: false,
        errorMessage: stderrLine
          ? `Hermes exited with code ${result.exit_code}: ${stderrLine}`
          : `Hermes exited with code ${result.exit_code}`,
        errorCode: null,
        resultJson: {
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.duration_ms,
        },
      };
    }

    return {
      exitCode: result.exit_code,
      signal: null,
      timedOut: false,
      errorMessage: result.exit_code !== 0
        ? `Hermes exited with code ${result.exit_code}`
        : null,
      usage: {
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        cachedInputTokens: parsed.cachedInputTokens,
      },
      sessionId: parsed.sessionId,
      sessionParams: parsed.sessionId ? { sessionId: parsed.sessionId, containerId } : null,
      sessionDisplayId: parsed.sessionId,
      provider: "fleetos",
      biller: "raava",
      model: parsed.model ?? (model || null),
      billingType: "api",
      costUsd: parsed.costUsd,
      resultJson: {
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.duration_ms,
      },
      summary: parsed.summary ?? null,
    };
  } catch (err) {
    const isClientError = err instanceof FleetOSClientError;
    const message = err instanceof Error ? err.message : String(err);

    // Differentiate connection failures (statusCode 0) from API errors (non-zero)
    const errorCode = isClientError
      ? (err.statusCode === 0 ? "fleetos_connection_error" : "fleetos_api_error")
      : "fleetos_connection_error";

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `FleetOS exec failed: ${message}`,
      errorCode,
      errorMeta: isClientError
        ? { statusCode: err.statusCode, detail: err.detail }
        : undefined,
    };
  }
}

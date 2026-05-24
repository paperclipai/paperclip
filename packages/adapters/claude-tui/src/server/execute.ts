import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  ensurePathInEnv,
  parseObject,
  sanitizeChildEnv,
} from "@paperclipai/adapter-utils/server-utils";
import {
  cleanupPerRunClaudeConfigDir,
  materializePerRunClaudeConfigDir,
  prepareClaudeTuiConfigSeed,
} from "./prepare-config-seed.js";

// Python CLI ships with the package at packages/adapters/claude-tui/python/.
// We probe multiple candidates because production loads this file via different
// resolution paths (tsx-loader realpath, pnpm symlink, bundled dist) and the
// "right" location depends on whether the python/ dir was copied next to src
// (workspace dev), next to dist (build-time copy), or globally via env.
const EXECUTE_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_CLI_CANDIDATES: string[] = (() => {
  const list: string[] = [];
  if (process.env.PYTHON_TUI_CLI_PATH) list.push(process.env.PYTHON_TUI_CLI_PATH);
  // workspace dev: src/server/execute.ts → ../../python/cli.py
  list.push(path.resolve(EXECUTE_MODULE_DIR, "..", "..", "python", "cli.py"));
  // build copy: dist/server/execute.js → ../python/cli.py (when build copies it next to dist)
  list.push(path.resolve(EXECUTE_MODULE_DIR, "..", "python", "cli.py"));
  // image-absolute fallback (matches Dockerfile's bundled location)
  list.push("/app/packages/adapters/claude-tui/python/cli.py");
  return Array.from(new Set(list));
})();
const PYTHON_INTERPRETER = process.env.PYTHON_TUI_INTERPRETER ?? "python3";
const DEFAULT_TIMEOUT_SEC = 3600;
const DEFAULT_GRACE_SEC = 20;
const SHUTDOWN_WAIT_MS = 5_000;

interface PythonEvent {
  type: string;
  [key: string]: unknown;
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

function resolveClaudeBillingType(
  env: Record<string, string>,
): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

function pathExistsSync(candidate: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:fs").existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Emit a single Paperclip-namespaced envelope on stdout via onLog. The UI
 * parser (separate file) re-parses these lines into TranscriptEntry records.
 */
async function emit(
  onLog: AdapterExecutionContext["onLog"],
  envelope: Record<string, unknown>,
): Promise<void> {
  await onLog("stdout", `${JSON.stringify(envelope)}\n`);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const configEnv = parseObject(config.env);
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);
  const model = asString(config.model, "");
  const instructionsFilePath = asString(config.instructionsFilePath, "");

  // Resolve the Python CLI by probing candidates. Multi-candidate probing
  // exists because the build assertion confirmed cli.py was in the image at
  // /app/packages/adapters/claude-tui/python/cli.py, yet runtime still saw it
  // as missing — most likely a pnpm/tsx resolution quirk where import.meta.url
  // pointed inside the .pnpm virtual store rather than the realpath.
  const resolvedPython = PYTHON_CLI_CANDIDATES.find(pathExistsSync) ?? null;
  if (!resolvedPython) {
    const moduleUrl = import.meta.url;
    const message =
      `claude_tui adapter: Python TUI CLI not found. ` +
      `Tried [${PYTHON_CLI_CANDIDATES.join(", ")}]. ` +
      `import.meta.url=${moduleUrl}. ` +
      `Set PYTHON_TUI_CLI_PATH to point at cli.py.`;
    await onLog("stderr", `${message}\n`);
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "claude_tui_cli_missing",
    };
  }
  const PYTHON_TUI_CLI_PATH = resolvedPython;

  // Build env. resolveAllCredentialEnv has already substituted secret refs in
  // configEnv into plain values (heartbeat.ts:7066). We just merge them onto
  // the Paperclip-managed env scaffolding.
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  for (const [key, value] of Object.entries(configEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  const hasExplicitApiKey =
    typeof env.PAPERCLIP_API_KEY === "string" && env.PAPERCLIP_API_KEY.trim().length > 0;
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Per-run isolated CLAUDE_CONFIG_DIR — see prepare-config-seed.ts for why we
  // do this for every run instead of claude-local's host-shared default.
  const seedDir = await prepareClaudeTuiConfigSeed(process.env, onLog, agent.companyId);
  const claudeConfigDir = await materializePerRunClaudeConfigDir({
    seedDir,
    runId,
    env: process.env,
  });
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  // Final spawn env (sanitized inherited + adapter env + ensured PATH).
  const spawnEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...sanitizeChildEnv(process.env), ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const billingType = resolveClaudeBillingType(spawnEnv);
  const provider = "anthropic";
  const biller = isBedrockAuth(spawnEnv) ? "aws_bedrock" : "anthropic";

  // Resolve the user's prompt. The TUI driver is multi-turn-capable but
  // Paperclip's adapter contract calls execute() once per run, so we send one
  // turn per invocation (matching claude_local behavior).
  const prompt = asString(context.paperclipWakePrompt, "")
    || asString(context.userPrompt, "")
    || asString(config.promptTemplate, "")
    || "";

  const cliArgs = [
    PYTHON_TUI_CLI_PATH,
    "--cwd",
    cwd,
    "--config-dir",
    claudeConfigDir,
    "--policy",
    "auto_approve",
  ];
  if (model) cliArgs.push("--model", model);
  if (instructionsFilePath) cliArgs.push("--instructions-file", instructionsFilePath);

  if (onMeta) {
    await onMeta({
      adapterType: "claude_tui",
      command: PYTHON_INTERPRETER,
      cwd,
      commandArgs: cliArgs,
      commandNotes: [
        "Driving the interactive Claude Code TUI via the Python CLI (spike).",
        "Per-run CLAUDE_CONFIG_DIR isolates session state from other agents.",
      ],
      env: { ...spawnEnv, CLAUDE_CONFIG_DIR: claudeConfigDir },
      prompt,
      promptMetrics: { promptChars: prompt.length },
      context,
    });
  }

  // detached:true puts the Python driver in its own process group so
  // Paperclip's cancellation path (heartbeat.ts:9356 → terminateLocalService)
  // can SIGTERM the whole group (Python + TUI child) with one kill(-pgid).
  const child = spawn(PYTHON_INTERPRETER, cliArgs, {
    cwd,
    env: spawnEnv,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const startedAt = new Date().toISOString();
  const pid = typeof child.pid === "number" ? child.pid : null;
  const processGroupId =
    pid && process.platform !== "win32"
      ? (() => {
          // detached:true puts the child in its own process group whose pgid
          // equals its pid; we don't need a syscall to look it up.
          return pid;
        })()
      : null;
  if (pid && onSpawn) {
    await onSpawn({ pid, processGroupId, startedAt }).catch(() => undefined);
  }

  // ---------------------------------------------------------------------
  // Stream stdout line by line, translate Python events into Paperclip
  // envelopes, and capture the final usage.
  // ---------------------------------------------------------------------
  let lastSessionId: string | null = null;
  let lastModel: string = model;
  let lastResponseText = "";
  // FIXME: The Python TUI reports a single `usage_pct` (0..100) per turn
  // rather than token counts. UsageSummary requires token counts, so we set
  // input/output tokens to 0 and surface usage_pct via resultJson for the UI.
  // This means claude_tui runs will NOT contribute meaningful token-based
  // billing data until the Python driver can expose true token counts.
  let lastUsagePct: number | null = null;
  let exitReason: string | null = null;
  let exitDetail: string | null = null;
  let stderrBuffer = "";

  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderrBuffer += text;
    void onLog("stderr", text).catch(() => undefined);
  });

  const stdoutDrained = new Promise<void>((resolve) => {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;
      let event: PythonEvent | null = null;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          event = parsed as PythonEvent;
        }
      } catch {
        // Non-JSON output — surface it as a plain stdout line so the UI
        // parser's fallback can show it.
        void onLog("stdout", `${rawLine}\n`).catch(() => undefined);
        return;
      }
      if (!event) return;
      void translateEvent(event).catch(() => undefined);
    });
    rl.on("close", () => resolve());
  });

  const translateEvent = async (event: PythonEvent): Promise<void> => {
    switch (event.type) {
      case "ready": {
        const sessionId = asString(event.session_id, "");
        const eventModel = asString(event.model, "");
        if (sessionId) lastSessionId = sessionId;
        if (eventModel) lastModel = eventModel;
        await emit(onLog, {
          type: "claude_tui.init",
          sessionId,
          model: eventModel || lastModel || "unknown",
          plan: event.plan ?? null,
        });
        break;
      }
      case "turn_start": {
        await emit(onLog, {
          type: "claude_tui.turn_start",
          prompt: asString(event.prompt, ""),
        });
        break;
      }
      case "modal": {
        await emit(onLog, {
          type: "claude_tui.modal",
          kind: asString(event.kind, ""),
          action: asString(event.action, ""),
          keySent: asString(event.key_sent, ""),
        });
        break;
      }
      case "chunk": {
        const text = asString(event.text, "");
        if (text) {
          lastResponseText += text;
          await emit(onLog, { type: "claude_tui.chunk", text });
        }
        break;
      }
      case "turn_end": {
        const responseText = asString(event.response_text, lastResponseText);
        const elapsedSec = asNumber(event.elapsed_sec, 0);
        const usagePctRaw = event.usage_pct;
        if (typeof usagePctRaw === "number" && Number.isFinite(usagePctRaw)) {
          lastUsagePct = usagePctRaw;
        }
        const exitReasonValue = asString(event.exit_reason, "");
        await emit(onLog, {
          type: "claude_tui.turn_end",
          responseText,
          elapsedSec,
          usagePct: lastUsagePct,
          exitReason: exitReasonValue || null,
        });
        break;
      }
      case "log": {
        const level = asString(event.level, "info");
        const msg = asString(event.msg, "");
        const stream = level === "error" || level === "warn" ? "stderr" : "stdout";
        await onLog(stream, `[claude_tui:${level}] ${msg}\n`);
        break;
      }
      case "exit": {
        exitReason = asString(event.reason, "") || null;
        exitDetail = asString(event.detail, "") || null;
        await emit(onLog, {
          type: "claude_tui.exit",
          reason: exitReason,
          detail: exitDetail,
        });
        break;
      }
      default: {
        // Unknown event types passed through as raw stdout for diagnostics.
        await onLog("stdout", `${JSON.stringify(event)}\n`);
      }
    }
  };

  // ---------------------------------------------------------------------
  // Write the user's prompt as a single turn command.
  // ---------------------------------------------------------------------
  try {
    child.stdin.write(`${JSON.stringify({ type: "turn", prompt })}\n`);
  } catch {
    // best-effort — the close event below will reject if stdin failed.
  }

  // ---------------------------------------------------------------------
  // Watchdog — SIGTERM the process group after timeoutSec, SIGKILL after
  // graceSec. Paperclip's cancellation path handles user-initiated cancel
  // by signalling the same PGID, so we don't wire a separate cancel hook.
  // ---------------------------------------------------------------------
  let timedOut = false;
  const watchdog =
    timeoutSec > 0
      ? setTimeout(() => {
          timedOut = true;
          signalProcessGroup(child, processGroupId, "SIGTERM");
          setTimeout(() => {
            signalProcessGroup(child, processGroupId, "SIGKILL");
          }, Math.max(1, graceSec) * 1000);
        }, timeoutSec * 1000)
      : null;

  // ---------------------------------------------------------------------
  // Wait for the child to exit. We do NOT proactively send shutdown until
  // turn_end has been reported (the contract has the driver hold the TUI
  // open between turns). Once turn_end arrives we ask it to exit cleanly.
  // ---------------------------------------------------------------------
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
      child.on("error", () => resolve({ code: null, signal: null }));
    },
  );

  // After we see "exit" event OR turn_end, request a clean shutdown.
  // We poll the captured state because translateEvent runs async.
  const requestShutdown = async (): Promise<void> => {
    try {
      child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      child.stdin.end();
    } catch {
      // ignore
    }
  };
  // Fire-and-forget timer that nudges shutdown shortly after lastResponseText
  // changes (i.e. the model finished producing output). We keep it simple: ask
  // for shutdown 250ms after we observe a turn_end-shaped state.
  const shutdownTimer = setInterval(() => {
    if (exitReason || lastUsagePct !== null) {
      clearInterval(shutdownTimer);
      void requestShutdown();
      // Force-terminate if the driver doesn't exit within SHUTDOWN_WAIT_MS.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          signalProcessGroup(child, processGroupId, "SIGTERM");
          setTimeout(() => {
            signalProcessGroup(child, processGroupId, "SIGKILL");
          }, Math.max(1, graceSec) * 1000);
        }
      }, SHUTDOWN_WAIT_MS);
    }
  }, 250);

  const { code, signal } = await exitPromise;
  clearInterval(shutdownTimer);
  if (watchdog) clearTimeout(watchdog);
  await stdoutDrained;

  // Best-effort cleanup of per-run config dir (housekeeping covers failures).
  await cleanupPerRunClaudeConfigDir(claudeConfigDir);

  const failed = (code ?? 0) !== 0 && !timedOut;
  const errorMessage = timedOut
    ? `Claude TUI timed out after ${timeoutSec}s`
    : failed
      ? exitDetail || stderrBuffer.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || `Claude TUI exited with code ${code ?? -1}`
      : null;

  // FIXME: usage_pct is a percentage, not a token count. We map it onto
  // UsageSummary.outputTokens=0 / inputTokens=0 and surface the real value via
  // resultJson.usagePct. Server-side billing (finance_events) treats this as
  // a no-op when both totals are zero; the UI can still show usage_pct from
  // resultJson once it lands a claude_tui parser.
  const usage: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };

  const sessionParams = lastSessionId
    ? ({
        sessionId: lastSessionId,
        cwd,
      } as Record<string, unknown>)
    : null;

  return {
    exitCode: code,
    signal: signal ?? null,
    timedOut,
    errorMessage,
    errorCode: timedOut ? "timeout" : failed ? "claude_tui_failed" : null,
    usage,
    sessionId: lastSessionId,
    sessionParams,
    sessionDisplayId: lastSessionId,
    provider,
    biller,
    model: lastModel || model || null,
    billingType,
    costUsd: null,
    summary: lastResponseText || null,
    resultJson: {
      usagePct: lastUsagePct,
      responseText: lastResponseText,
      exitReason,
      exitDetail,
    },
  };
}

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  processGroupId: number | null,
  signal: NodeJS.Signals,
): void {
  if (child.killed) return;
  if (process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    return;
  }
  if (processGroupId && processGroupId > 0) {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch {
      // fall through to direct kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

// Suppress unused-import warning for path (kept for parity with claude-local).
void path;

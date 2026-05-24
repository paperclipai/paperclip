import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, statSync } from "node:fs";
import fs from "node:fs/promises";
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
  renderTemplate,
  renderPaperclipWakePrompt,
  joinPromptSections,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";

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
    return existsSync(candidate);
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

  const resolvedPython = PYTHON_CLI_CANDIDATES.find(pathExistsSync) ?? null;
  if (!resolvedPython) {
    const moduleUrl = import.meta.url;
    const probe = (p: string): string => {
      try {
        const st = statSync(p);
        return `${p} OK ${st.isDirectory() ? "dir" : st.isFile() ? `file ${st.size}b` : "other"} mode=${(st.mode & 0o777).toString(8)}`;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code ?? "?";
        return `${p} MISSING ${code}`;
      }
    };
    const lsDir = (p: string): string => {
      try {
        return `${p}: ${readdirSync(p).join(",")}`;
      } catch (err: unknown) {
        return `${p}: <${(err as NodeJS.ErrnoException).code ?? "err"}>`;
      }
    };
    const diagnostics = [
      probe("/app/packages/adapters/claude-tui"),
      probe("/app/packages/adapters/claude-tui/python"),
      probe("/app/packages/adapters/claude-tui/python/cli.py"),
      probe("/app/packages/adapters/claude-tui/dist/python/cli.py"),
      probe("/app/Dockerfile"),
      probe("/app/server/dist/index.js"),
      lsDir("/app/packages/adapters/claude-tui"),
      lsDir("/app/packages/adapters/claude-tui/dist"),
    ].join(" | ");
    const message =
      `claude_tui adapter: Python TUI CLI not found. ` +
      `Tried [${PYTHON_CLI_CANDIDATES.join(", ")}]. ` +
      `import.meta.url=${moduleUrl}. ` +
      `Diagnostics: ${diagnostics}. ` +
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

  // Credential resolution: rely on the same HOME-based mechanism claude-local
  // uses. resolveCredentialEnv (services/credentials.ts) materializes the
  // agent's claude_oauth payload to `${HOME}/.claude/.credentials.json` and
  // sets HOME in configEnv to that per-agent dir; Claude Code picks it up
  // automatically. Overriding CLAUDE_CONFIG_DIR here would point Claude Code
  // away from those creds, so we leave the env as-is.
  //
  // Per-run TUI config isolation (the original intent of prepareClaudeTuiConfigSeed)
  // can be reintroduced as an opt-in feature once we have a way to seed it from
  // the agent's HOME rather than process.env.HOME.
  const claudeConfigDir = asString(configEnv.CLAUDE_CONFIG_DIR, "");
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;

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
  //
  // Prompt assembly mirrors claude_local: render the wake payload (if any),
  // render the configured promptTemplate against templateData, then join. We
  // never want to send an empty turn — the TUI just sits idle and the
  // heartbeat watchdog kills it as `process_lost`.
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake);
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const explicitUserPrompt = asString(context.paperclipWakePrompt, "")
    || asString(context.userPrompt, "");
  const prompt = joinPromptSections([
    explicitUserPrompt,
    wakePrompt,
    renderedPrompt,
  ]);

  // Pre-accept the cwd in ${HOME}/.claude.json so the TUI doesn't show the
  // "Do you trust the files in this folder?" dialog on first run. credentials.ts
  // already seeded hasCompletedOnboarding; we merge in the per-project trust
  // entry here because cwd is only known at adapter-execution time.
  const agentHome = typeof spawnEnv.HOME === "string" ? spawnEnv.HOME : "";
  if (agentHome) {
    const globalConfigFile = path.join(agentHome, ".claude.json");
    try {
      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(globalConfigFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
        }
      } catch {
        // missing — credentials.ts always seeds it for claude_oauth, but if
        // the agent runs without that credential type we still want trust
        // pre-accepted.
      }
      const projects =
        existing.projects && typeof existing.projects === "object" && !Array.isArray(existing.projects)
          ? { ...(existing.projects as Record<string, unknown>) }
          : {};
      const prior =
        projects[cwd] && typeof projects[cwd] === "object" && !Array.isArray(projects[cwd])
          ? (projects[cwd] as Record<string, unknown>)
          : {};
      projects[cwd] = {
        ...prior,
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount:
          typeof prior.projectOnboardingSeenCount === "number" && prior.projectOnboardingSeenCount > 0
            ? prior.projectOnboardingSeenCount
            : 1,
      };
      const next = {
        ...existing,
        hasCompletedOnboarding: true,
        lastOnboardingVersion:
          typeof existing.lastOnboardingVersion === "string" ? existing.lastOnboardingVersion : "2.1.141",
        projects,
      };
      await fs.writeFile(globalConfigFile, JSON.stringify(next), "utf-8");
      await fs.chmod(globalConfigFile, 0o600).catch(() => undefined);
    } catch {
      // best-effort; the TUI driver also handles onboarding screens defensively.
    }
  }

  const cliArgs = [
    PYTHON_TUI_CLI_PATH,
    "--cwd",
    cwd,
    "--policy",
    "auto_approve",
  ];
  // We intentionally do NOT pass --dangerously-skip-permissions: it triggers
  // a "Yes, I accept" modal whose default selection is "No, exit", and the
  // arrow-key navigation we'd need to dismiss it doesn't reach claude
  // reliably during early init. Per-tool permission prompts are instead
  // auto-approved by modal_handler under policy=auto_approve, which is the
  // path the TUI driver was designed for.
  if (claudeConfigDir) {
    cliArgs.push("--config-dir", claudeConfigDir);
  }
  // NOTE: model + instructionsFile aren't wired through the Python CLI yet —
  // the CLI's argparse only accepts the flags above. The instructions live at
  // `instructionsFilePath` and need a separate plumbing pass (likely via
  // `claude --append-system-prompt @file` inside driver.py). Logged here to
  // surface in onMeta so the gap is visible.
  void model;
  void instructionsFilePath;

  if (onMeta) {
    await onMeta({
      adapterType: "claude_tui",
      command: PYTHON_INTERPRETER,
      cwd,
      commandArgs: cliArgs,
      commandNotes: [
        "Driving the interactive Claude Code TUI via the Python CLI (spike).",
        claudeConfigDir
          ? `Using CLAUDE_CONFIG_DIR=${claudeConfigDir}.`
          : "Inheriting Claude config from agent HOME/.claude (no per-run override).",
      ],
      env: spawnEnv,
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

  // Per-run config-dir cleanup is a no-op now that we share the agent's
  // HOME/.claude instead of materializing a per-run isolated copy.

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

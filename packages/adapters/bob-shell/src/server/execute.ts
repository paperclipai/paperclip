/**
 * Server-side execute implementation for the IBM Bob Shell adapter.
 *
 * Runs `bob run` in non-interactive (stream-json) mode and interprets the
 * NDJSON event stream to produce an AdapterExecutionResult.
 *
 * Bob Shell stream-json event types (from official docs):
 *   - message       : { type, role, content, isReasoning? }
 *   - tool_use      : { type, tool_name, tool_id, parameters }
 *   - tool_result   : { type, tool_id, status, output?, error? }
 *   - error         : { type, severity, message }
 *   - result        : { type, status, stats, last_message }
 *
 * The `result` event's stats object contains:
 *   task_id, total_tokens, input_tokens, output_tokens,
 *   cache_read_tokens, cache_write_tokens, cache_ratio,
 *   duration_ms, session_costs, tool_calls
 */

import path from "node:path";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv,
  runChildProcess,
  renderTemplate,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";

import {
  ADAPTER_TYPE,
  BOB_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MAX_COST,
  DEFAULT_MAX_TURNS,
} from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" && isFinite(v) ? v : undefined;
}

function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function cfgStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return v as string[];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

export function resolveBobCommand(config: Record<string, unknown>): string {
  return cfgString(config.bobCommand) ?? BOB_CLI;
}

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

const BOB_DEFAULT_PROMPT_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "Paperclip API guidance:",
  "- Use `curl` for Paperclip API calls.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): string {
  const context = (ctx as unknown as Record<string, unknown>).context ?? {};
  const template =
    cfgString(config.promptTemplate) ?? BOB_DEFAULT_PROMPT_TEMPLATE;

  const taskId =
    cfgString((context as Record<string, unknown>).taskId) ??
    cfgString((context as Record<string, unknown>).issueId) ??
    cfgString(ctx.config?.taskId);
  const taskTitle =
    cfgString((context as Record<string, unknown>).taskTitle) ??
    cfgString(ctx.config?.taskTitle) ??
    "";
  const taskBody =
    cfgString((context as Record<string, unknown>).taskBody) ??
    cfgString(ctx.config?.taskBody) ??
    "";
  const commentId =
    cfgString((context as Record<string, unknown>).commentId) ??
    cfgString((context as Record<string, unknown>).wakeCommentId) ??
    "";
  const wakeReason =
    cfgString((context as Record<string, unknown>).wakeReason) ?? "";
  const companyName =
    cfgString((context as Record<string, unknown>).companyName) ?? "";
  const projectName =
    cfgString((context as Record<string, unknown>).projectName) ?? "";

  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ??
    process.env.PAPERCLIP_API_URL ??
    "http://127.0.0.1:3100/api";
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id ?? "",
    agentName: ctx.agent?.name ?? "Bob Shell Agent",
    companyId: ctx.agent?.companyId ?? "",
    companyName,
    runId: ctx.runId ?? "",
    agent: ctx.agent ?? {},
    company: { id: ctx.agent?.companyId ?? "", name: companyName },
    run: { id: ctx.runId ?? "", source: "on_demand" },
    context,
    taskId: taskId ?? "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
  };

  return renderTemplate(template, vars);
}

// ---------------------------------------------------------------------------
// Stream-JSON output parser
// ---------------------------------------------------------------------------

export interface BobStreamResultStats {
  task_id?: string;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cache_ratio?: number;
  duration_ms?: number;
  session_costs?: number;
  tool_calls?: number;
}

export interface BobStreamResult {
  type: "result";
  status: "success" | "error";
  stats?: BobStreamResultStats;
  last_message?: string;
}

export interface ParsedBobOutput {
  taskId?: string;
  lastMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  status?: "success" | "error";
  errorMessage?: string;
  errorSeverity?: string;
}

/**
 * Parse Bob Shell stream-json NDJSON output.
 *
 * Finds the terminal `result` event and error events in the stream.
 * The task_id in stats is used as the session ID for --resume support.
 */
export function parseBobStreamOutput(stdout: string): ParsedBobOutput {
  const result: ParsedBobOutput = {};

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("{")) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = event.type;

    if (type === "error") {
      const msg = typeof event.message === "string" ? event.message : null;
      if (msg) {
        result.errorMessage = msg;
        result.errorSeverity =
          typeof event.severity === "string" ? event.severity : undefined;
      }
    }

    if (type === "result") {
      const bobResult = event as unknown as BobStreamResult;
      result.status = bobResult.status;
      result.lastMessage = bobResult.last_message ?? undefined;

      const stats = bobResult.stats;
      if (stats) {
        if (stats.task_id) result.taskId = stats.task_id;
        if (typeof stats.input_tokens === "number")
          result.inputTokens = stats.input_tokens;
        if (typeof stats.output_tokens === "number")
          result.outputTokens = stats.output_tokens;
        if (typeof stats.cache_read_tokens === "number")
          result.cachedInputTokens = stats.cache_read_tokens;
        if (typeof stats.session_costs === "number")
          result.costUsd = stats.session_costs;
      }

      if (bobResult.status === "error" && !result.errorMessage) {
        result.errorMessage = bobResult.last_message ?? "Bob run failed";
      }
    }
  }

  return result;
}

/**
 * Detect whether Bob output indicates cost/turn limit reached.
 */
export function isBobLimitError(output: string): boolean {
  return output.includes('"severity":"cost"') ||
    output.includes('"severity":"turns"') ||
    output.includes("--max-cost") ||
    output.includes("--max-turns");
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<
    string,
    unknown
  >;

  // ── Resolve configuration ────────────────────────────────────────────────
  const bobCmd = resolveBobCommand(config);
  const timeoutSec = cfgNumber(config.timeoutSec) ?? DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) ?? DEFAULT_GRACE_SEC;
  const maxCost = cfgNumber(config.maxCost) ?? DEFAULT_MAX_COST;
  const maxTurns = cfgNumber(config.maxTurns) ?? DEFAULT_MAX_TURNS;
  const mode = cfgString(config.mode);
  const workspace = cfgString(config.workspace);
  const teamId = cfgString(config.teamId);
  const disableMcp = cfgBoolean(config.disableMcp) === true;
  const disableSubagents = cfgBoolean(config.disableSubagents) === true;
  const extraArgs = cfgStringArray(config.extraArgs) ?? [];
  const cwd =
    cfgString(config.cwd) ??
    cfgString(ctx.config?.workspaceDir) ??
    process.cwd();

  // ── Session management (bob --resume <task-id>) ─────────────────────────
  const runtimeParams = ctx.runtime?.sessionParams as
    | Record<string, unknown>
    | null
    | undefined;
  const prevTaskId =
    cfgString(runtimeParams?.taskId) ??
    cfgString(runtimeParams?.task_id) ??
    null;

  // Only resume if cwd matches (prevent cross-project session contamination)
  const prevSessionCwd = cfgString(runtimeParams?.cwd) ?? "";
  const canResume =
    prevTaskId !== null &&
    (prevSessionCwd.length === 0 ||
      path.resolve(prevSessionCwd) === path.resolve(cwd));

  // ── Build prompt ─────────────────────────────────────────────────────────
  const prompt = buildPrompt(ctx, config);

  // ── Build command args ───────────────────────────────────────────────────
  const args: string[] = [];

  if (canResume) {
    // Resume mode: `bob run --resume <task-id>`
    args.push("run", "--resume", prevTaskId!);
  } else {
    args.push("run");
  }

  // Always use stream-json for machine-readable output
  args.push("--format", "stream-json");

  if (mode) {
    args.push("--mode", mode);
  }

  if (maxCost > 0) {
    args.push("--max-cost", String(maxCost));
  }

  if (maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (workspace) {
    args.push("--workspace", workspace);
  }

  if (teamId) {
    args.push("--team-id", teamId);
  }

  if (disableMcp) {
    args.push("--disable-mcp");
  }

  if (disableSubagents) {
    args.push("--disable-subagents");
  }

  // Trust the current workspace (non-interactive mode still may prompt)
  args.push("--trust");

  // Accept license silently
  args.push("--accept-license");

  if (extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  // Prompt is passed via stdin — not as a positional arg — so that multiline
  // prompts are delivered intact. Bob reads from stdin when no positional
  // prompt argument is present (equivalent to: cat prompt.txt | bob run).
  // Normalize to LF so the stream is consistent on Windows.
  const stdinPrompt = prompt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // ── Build environment ────────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // Inject Paperclip API key from harness token (never from config)
  delete env.PAPERCLIP_API_KEY;
  if (ctx.authToken) {
    env.PAPERCLIP_API_KEY = ctx.authToken;
  }

  // Task context env vars
  const ctxContext = ctx.context ?? {};
  const envTaskId =
    cfgString(ctxContext.taskId) ??
    cfgString(ctxContext.issueId) ??
    cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;

  const envWakeReason =
    cfgString(ctxContext.wakeReason) ?? cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;

  const envCommentId =
    cfgString(ctxContext.commentId) ??
    cfgString(ctxContext.wakeCommentId) ??
    cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  // ── Log start ────────────────────────────────────────────────────────────
  const sessionLabel = canResume
    ? `resuming session ${prevTaskId}`
    : "new session";
  await ctx.onLog(
    "stdout",
    `[bob-shell] Starting IBM Bob Shell (${sessionLabel}, timeout=${timeoutSec}s${maxTurns > 0 ? `, max_turns=${maxTurns}` : ""}${maxCost > 0 ? `, max_cost=${maxCost}` : ""})\n`,
  );

  // ── Execute ──────────────────────────────────────────────────────────────
  const result = await runChildProcess(ctx.runId, bobCmd, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: ctx.onLog,
    onSpawn: ctx.onSpawn,
    stdin: stdinPrompt,
  });

  // ── Parse output ─────────────────────────────────────────────────────────
  const parsed = parseBobStreamOutput(result.stdout ?? "");

  await ctx.onLog(
    "stdout",
    `[bob-shell] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.taskId) {
    await ctx.onLog("stdout", `[bob-shell] Session task ID: ${parsed.taskId}\n`);
  }
  if (parsed.status) {
    await ctx.onLog(
      "stdout",
      `[bob-shell] Bob run status: ${parsed.status}\n`,
    );
  }

  // ── Build result ─────────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: "ibm",
    model: cfgString(config.model) ?? null,
  };

  // Error handling
  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (
    !result.timedOut &&
    typeof result.exitCode === "number" &&
    result.exitCode !== 0
  ) {
    executionResult.errorMessage = `Bob Shell exited with code ${result.exitCode}`;
  }

  // Token usage
  if (
    typeof parsed.inputTokens === "number" ||
    typeof parsed.outputTokens === "number"
  ) {
    executionResult.usage = {
      inputTokens: parsed.inputTokens ?? 0,
      outputTokens: parsed.outputTokens ?? 0,
      cachedInputTokens: parsed.cachedInputTokens,
    };
  }

  // Cost
  if (typeof parsed.costUsd === "number") {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary
  if (parsed.lastMessage) {
    executionResult.summary = parsed.lastMessage;
  }

  // Session persistence: store the bob task_id + cwd for --resume
  if (parsed.taskId) {
    executionResult.sessionParams = {
      taskId: parsed.taskId,
      cwd: path.resolve(cwd),
    };
    executionResult.sessionDisplayId = parsed.taskId;
  } else if (canResume) {
    // Keep the existing session alive if Bob didn't emit a result event
    // (e.g. interrupted or timed out mid-run)
    executionResult.sessionParams = {
      taskId: prevTaskId,
      cwd: path.resolve(cwd),
    };
    executionResult.sessionDisplayId = prevTaskId ?? undefined;
  }

  // Raw result JSON for debugging
  executionResult.resultJson = {
    parsed,
    stdout: result.stdout?.slice(-4096) ?? null,
    stderr: result.stderr?.slice(-4096) ?? null,
  };

  return executionResult;
}

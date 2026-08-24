/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import fs from "node:fs/promises";
import { extractPaperclipDisposition, type ParsedDisposition } from "@paperclipai/adapter-utils";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { weightedBudgetTokens } from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
  runningProcesses,
  signalRunningProcess,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  VALID_PROVIDERS,
  HERMES_PAPERCLIP_WAKE_DISCIPLINE_LINES,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

// Hermes was the only LLM adapter with NO final-text disposition extraction:
// it relied solely on in-run Paperclip bridge writes, so any run that ended
// without completing that write (turn wall, budget wall, disconnect) lost an
// otherwise valid lifecycle decision. Mirror the ACPX contract: parse the
// final response for the strict single-line PAPERCLIP_DISPOSITION record,
// tolerant of Markdown-concatenated markers (`**Final**PAPERCLIP_...`).
const PAPERCLIP_DISPOSITION_STATUSES = new Set(["done", "cancelled", "in_review", "blocked"]);

type ParsedHermesDisposition = {
  status: string;
  hasBlocker: boolean;
  blocker?: string;
  reviewer?: string;
};

function parseDispositionRecord(value: unknown): ParsedHermesDisposition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!PAPERCLIP_DISPOSITION_STATUSES.has(status)) return null;
  const blocker = [record.blocker, record.reason, record.statusReason]
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0)
    ?.trim();
  const reviewer = typeof record.reviewer === "string" && record.reviewer.trim()
    ? record.reviewer.trim()
    : undefined;
  return {
    status,
    hasBlocker: record.hasBlocker === true || status === "blocked",
    ...(blocker ? { blocker } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}


function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

export function resolveHermesCommand(config: Record<string, unknown>): string {
  return cfgString(config.hermesCommand) || cfgString(config.command) || HERMES_CLI;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const HERMES_DEFAULT_PROMPT_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
  "",
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
  "- Use `$PAPERCLIP_API_KEY` for the currently claimed issue. For cross-issue comments/status updates or scoped child-task work, use `$PAPERCLIP_BRIDGE_API_KEY` when it is present.",
  "- Displayed command logs may redact secrets; rely on environment variables instead of printed token values.",
  "- Include `-H \"Authorization: Bearer $PAPERCLIP_API_KEY\"` on API requests.",
  "- Include `-H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\"` on mutating issue requests.",
  "- For multiline comments or status updates, preserve newlines with `jq --arg` or a heredoc-fed helper rather than hand-escaping JSON.",
  "",
  "Safe multiline update pattern:",
  "```bash",
  "api=\"${PAPERCLIP_API_URL%/}\"",
  "case \"$api\" in */api) ;; *) api=\"$api/api\" ;; esac",
  "",
  "body=$(cat <<'MD'",
  "Summary line",
  "",
  "- Detail one",
  "- Detail two",
  "MD",
  ")",
  "jq -n --arg status done --arg comment \"$body\" '{status:$status, comment:$comment}' | \\",
  "  curl -sS -X PATCH \"$api/issues/{{context.issueId}}\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

const HERMES_WAKE_DISCIPLINE_SECTION =
  HERMES_PAPERCLIP_WAKE_DISCIPLINE_LINES.join("\n");

const execFileAsync = promisify(execFile);
const DEFAULT_RECOVERY_MAX_TURNS = 2;

function renderConditionalSections(template: string, vars: Record<string, unknown>): string {
  const isTruthy = (key: string) => {
    if (key === "noTask") return !vars.taskId;
    const value = vars[key];
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  };
  return template.replace(
    /\{\{#([a-zA-Z0-9_.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => (isTruthy(key) ? body : ""),
  );
}

function renderManagedInstructionsSection(input: {
  agentInstructions?: string;
  instructionsFilePath?: string;
}): string {
  const agentInstructions = input.agentInstructions?.trim();
  if (!agentInstructions) return "";

  const lines = [
    "Managed agent instructions:",
    "- These instructions are internal runtime policy. Follow them, but do not quote or restate them into Paperclip comments or final summaries unless the task explicitly requires a verbatim quote.",
    agentInstructions,
  ];

  if (input.instructionsFilePath) {
    const instructionsFileDir = path.dirname(input.instructionsFilePath);
    lines.push(
      `Managed instructions source: ${input.instructionsFilePath}`,
      `Resolve any relative file references from ${instructionsFileDir}/.`,
    );
  }

  return lines.join("\n");
}

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: {
    resumedSession?: boolean;
    agentInstructions?: string;
    instructionsFilePath?: string;
  } = {},
): string {
  const template = cfgString(config.promptTemplate) || HERMES_DEFAULT_PROMPT_TEMPLATE;

  const context = (ctx as any).context || {};
  const taskId = cfgString(context.taskId) || cfgString(context.issueId) || cfgString(ctx.config?.taskId);
  const taskTitle = cfgString(context.taskTitle) || cfgString(ctx.config?.taskTitle) || "";
  const taskBody = cfgString(context.taskBody) || cfgString(ctx.config?.taskBody) || "";
  const commentId = cfgString(context.commentId) || cfgString(context.wakeCommentId) || cfgString(ctx.config?.commentId) || "";
  const wakeReason = cfgString(context.wakeReason) || cfgString(ctx.config?.wakeReason) || "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName = cfgString(context.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName = cfgString(context.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const paperclipTaskMarkdown = selectPaperclipTaskMarkdown(context, {
    resumedSession: options.resumedSession === true,
  });
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: options.resumedSession === true,
    // The task-context markdown is the authoritative brief on this lane; keep
    // the wake prompt's description copy out so the prompt carries it once.
    suppressIssueDescription: paperclipTaskMarkdown.length > 0,
    // A fresh Hermes session already receives the full task brief below. Do
    // not replay the prior-run summary into the same prompt.
    suppressContinuationSummary: options.resumedSession !== true,
  });
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake, {
    // Custom Hermes prompt templates can embed this JSON. Keep it aligned with
    // the rendered prompt so a fresh session does not receive the old summary
    // through a second channel.
    omitContinuationSummary: options.resumedSession !== true,
  }) || "";
  const recoveryScoped = isPaperclipRecoveryWakePayload(context.paperclipWake);
  // Recovery wakes are deliberately limited to recording or repairing the
  // execution path. Re-sending a full managed-instructions bundle (often tens
  // of KB) is pure context tax and can turn a one-write repair into a large
  // resumed session. The compact recovery contract in paperclipWakePrompt is
  // authoritative for this path.
  const managedInstructionsSection = recoveryScoped
    ? ""
    : renderManagedInstructionsSection({
      agentInstructions: options.agentInstructions,
      instructionsFilePath: options.instructionsFilePath,
    });

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    agent: ctx.agent || {},
    company: { id: ctx.agent?.companyId || "", name: companyName },
    run: { id: ctx.runId || "", source: "on_demand" },
    context,
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    wakeReason,
    projectName,
    paperclipApiUrl,
    paperclipWakePrompt: wakePrompt,
    paperclipTaskMarkdown,
    taskContext: paperclipTaskMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipBridgeApiKeyEnv: "PAPERCLIP_BRIDGE_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const rendered = isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? ""
    : renderTemplate(renderConditionalSections(template, vars), vars);
  // Keep the discipline section at the top for the default template. A custom
  // template may choose to place it itself, in which case avoid duplication.
  const wakeDisciplineSection = rendered.includes(HERMES_WAKE_DISCIPLINE_SECTION)
    ? ""
    : HERMES_WAKE_DISCIPLINE_SECTION;
  return joinPromptSections([
    wakeDisciplineSection,
    rendered,
    managedInstructionsSection,
    wakePrompt,
    sessionHandoffMarkdown,
    paperclipTaskMarkdown,
  ]);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/** Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>" */
const SESSION_ID_REGEX = /^session_id:\s*(\S+)/m;

/** Regex for legacy session output format */
const SESSION_ID_REGEX_LEGACY = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/**
 * Hermes emits this line from its CLI (not from model output) whenever its
 * configured tool-turn budget is exhausted.  Keep the transport marker
 * deliberately narrow: Paperclip must never infer a scheduler stop state
 * from arbitrary assistant/tool prose.
 */
const PAPERCLIP_STOP_REASON_REGEX = /^paperclip_stop_reason:\s*(max_turns_exhausted)\s*$/mi;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
  stopReason?: "max_turns_exhausted";
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("Query:")) return false;
      if (t.startsWith("Initializing agent")) return false;
      if (t.startsWith("Resume this session with:")) return false;
      if (t.startsWith("Session:") || t.startsWith("Duration:") || t.startsWith("Messages:")) return false;
      if (t.startsWith("Warning: Unknown toolsets:")) return false;
      if (t.startsWith("Warning: Input is not a terminal")) return false;
      if (t.startsWith("Goodbye!")) return false;
      if (t.startsWith("session_id:")) return false;
      if (t.startsWith("hermes --resume ")) return false;
      if (/^[─━]+$/.test(t)) return false;
      if (/^[╭╰│].*$/.test(t)) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // This marker is emitted by Hermes' own single-query CLI after it receives
  // the structured turn_exit_reason from the runtime. Do not inspect the
  // response text for phrases such as "maximum iterations": that text is
  // model-controlled and cannot safely drive task lifecycle state.
  if (PAPERCLIP_STOP_REASON_REGEX.test(stderr)) {
    result.stopReason = "max_turns_exhausted";
  }

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    const cleaned = cleanResponse(stdout.replace(SESSION_ID_REGEX, ""));
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  } else {
    // Legacy format (non-quiet mode)
    const legacyMatch = combined.match(SESSION_ID_REGEX_LEGACY);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch?.[1] ?? null;
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

async function readHermesSessionUsage(sessionId: string): Promise<UsageSummary | undefined> {
  // Hermes persists cumulative per-session usage locally even when quiet CLI
  // output omits token totals. Read it opportunistically; failures must never
  // affect task execution because non-local Hermes installs may not have this
  // SQLite database or the sqlite3 CLI.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined;
  const stateDbPath = process.env.HERMES_STATE_DB || path.join(os.homedir(), ".hermes", "state.db");
  try {
    await fs.access(stateDbPath);
    // `sessions` contains session metadata only. Hermes keeps its token
    // ledger separately, per model/provider/task, so aggregate those rows
    // into the cumulative session total that the heartbeat service can delta.
    const query = [
      "SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,",
      "COALESCE(SUM(output_tokens), 0) AS outputTokens,",
      "COALESCE(SUM(cache_read_tokens), 0) AS cachedInputTokens",
      "FROM session_model_usage",
      `WHERE session_id = '${sessionId}'`,
      "LIMIT 1;",
    ].join(" ");
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", stateDbPath, query], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const row = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const usage = row[0];
    if (!usage) return undefined;
    const inputTokens = cfgNumber(usage.inputTokens) ?? 0;
    const outputTokens = cfgNumber(usage.outputTokens) ?? 0;
    const cachedInputTokens = cfgNumber(usage.cachedInputTokens) ?? 0;
    if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
    return { inputTokens, outputTokens, cachedInputTokens };
  } catch {
    return undefined;
  }
}

async function readHermesRunUsageBySource(
  source: string,
): Promise<{ sessionId: string; usage: UsageSummary } | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(source)) return undefined;
  const stateDbPath = process.env.HERMES_STATE_DB || path.join(os.homedir(), ".hermes", "state.db");
  try {
    await fs.access(stateDbPath);
    const query = [
      "SELECT id AS sessionId, input_tokens AS inputTokens,",
      "output_tokens AS outputTokens, cache_read_tokens AS cachedInputTokens",
      "FROM sessions",
      `WHERE source = '${source}'`,
      "ORDER BY started_at DESC LIMIT 1;",
    ].join(" ");
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", stateDbPath, query], {
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    });
    const row = (JSON.parse(stdout) as Array<Record<string, unknown>>)[0];
    const sessionId = cfgString(row?.sessionId);
    if (!row || !sessionId) return undefined;
    return {
      sessionId,
      usage: {
        inputTokens: cfgNumber(row.inputTokens) ?? 0,
        outputTokens: cfgNumber(row.outputTokens) ?? 0,
        cachedInputTokens: cfgNumber(row.cachedInputTokens) ?? 0,
      },
    };
  } catch {
    return undefined;
  }
}

function totalUsageTokens(usage: UsageSummary | undefined): number {
  if (!usage) return 0;
  // Budget-weighted: cache reads at reduced weight so multi-turn runs are not
  // charged turns x resident-context (TSMC-20840). Only feeds the per-run
  // token budget; reported usage stays raw.
  return weightedBudgetTokens(usage);
}

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = resolveHermesCommand(config);
  const model = cfgString(config.model) || DEFAULT_MODEL;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const maxTokensPerRun = Math.max(0, Math.floor(cfgNumber(config.maxTokensPerRun) ?? 0));
  const liveUsagePollIntervalMs = Math.max(
    5,
    Math.min(5_000, Math.floor(cfgNumber(config.liveUsagePollIntervalMs) ?? 250)),
  );
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  // Paperclip already injects the scoped task, managed instructions, and wake
  // contract into the query. Letting Hermes inject host AGENTS.md files and
  // persistent personal memory as well can both duplicate context and steer a
  // run toward an unrelated previous task. Keep provider/user configuration
  // available, but isolate rules and memory unless an operator explicitly
  // opts out for a compatibility case.
  const ignoreRules = cfgBoolean(config.ignoreRules) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  const isRecoveryWake = isPaperclipRecoveryWakePayload((ctx as any).context?.paperclipWake);
  const recoveryMaxTurns = cfgNumber(config.recoveryMaxTurns) ?? DEFAULT_RECOVERY_MAX_TURNS;
  const effectiveMaxTurns = isRecoveryWake
    ? Math.min(maxTurns && maxTurns > 0 ? maxTurns : recoveryMaxTurns, recoveryMaxTurns)
    : maxTurns;

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (detected at runtime)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  //
  // This ensures that even if the agent was created before provider tracking
  // was added, or if the model was changed without updating provider, the
  // correct provider is still used.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  const explicitProvider = cfgString(config.provider);

  if (!explicitProvider) {
    try {
      detectedConfig = await detectModel();
    } catch {
      // Non-fatal — detection failure shouldn't block execution
    }
  }

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // ── Load agent instructions file (Paperclip instruction bundles) ──────
  // Paperclip can materialize managed instructions into instructionsFilePath;
  // when present, inject that bundle into the Hermes prompt.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      await ctx.onLog(
        "stdout",
        `[hermes] Loaded agent instructions from ${instructionsFilePath} (${loadedInstructionsLength} chars)\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Non-fatal: log to stdout with an explicit "Warning:" prefix so the
      // Paperclip UI doesn't render this as a red error (stderr output is
      // surfaced as an error signal even when execution continues).
      await ctx.onLog(
        "stdout",
        `[hermes] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  const prompt = buildPrompt(ctx, config, {
    resumedSession: Boolean(prevSessionId),
    agentInstructions,
    instructionsFilePath,
  });

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) by default so Hermes does not echo the query text or TUI chrome
  // back into Paperclip comments/results. `quiet: false` remains as an escape hatch.
  const useQuiet = cfgBoolean(config.quiet) !== false;
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (effectiveMaxTurns && effectiveMaxTurns > 0) {
    args.push("--max-turns", String(effectiveMaxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // A unique source lets Paperclip read the live Hermes usage ledger for this
  // exact run without confusing concurrent sessions. It also keeps these
  // integration sessions separate from the user's ordinary CLI history.
  const runSource = ctx.runId
    ? `paperclip_${ctx.runId.replace(/[^A-Za-z0-9_-]/g, "_")}`
    : "paperclip_tool";
  args.push("--source", runSource);

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  if (ignoreRules) args.push("--ignore-rules");

  if (persistSession && prevSessionId) {
    args.push("--resume", prevSessionId);
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent),
  };

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
  // token is the only source of Paperclip API identity.
  delete env.PAPERCLIP_API_KEY;
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;

  // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
  const ctxContext = (ctx as any).context || {};
  const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;
  const wakePayloadJson = stringifyPaperclipWakePayload(ctxContext.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  // ── Resolve working directory ──────────────────────────────────────────
  // The execution workspace selected by Paperclip is authoritative. Older
  // Hermes agents often retain an agent-home `cwd`; letting that value win
  // silently writes task artifacts outside the issue's project workspace.
  const paperclipWorkspace = ctx.context && typeof ctx.context === "object"
    ? (ctx.context.paperclipWorkspace as Record<string, unknown> | undefined)
    : undefined;
  const cwd =
    cfgString(ctx.config?.workspaceDir) ||
    cfgString(paperclipWorkspace?.cwd) ||
    cfgString(config.cwd) ||
    ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${effectiveMaxTurns ? `, max_turns=${effectiveMaxTurns}` : ""})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  let tokenBudgetExceeded = false;
  let tokenBudgetObserved = 0;
  let monitoredSessionId: string | undefined;
  let monitoredUsage: UsageSummary | undefined;
  let monitorBusy = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const pollLiveUsage = async () => {
    if (monitorBusy || tokenBudgetExceeded || maxTokensPerRun <= 0) return;
    monitorBusy = true;
    try {
      const live = await readHermesRunUsageBySource(runSource);
      if (!live) return;
      monitoredSessionId = live.sessionId;
      monitoredUsage = live.usage;
      tokenBudgetObserved = Math.max(tokenBudgetObserved, totalUsageTokens(live.usage));
      if (tokenBudgetObserved < maxTokensPerRun) return;

      tokenBudgetExceeded = true;
      await ctx.onLog(
        "stderr",
        `[paperclip] Hermes maxTokensPerRun budget of ${maxTokensPerRun} tokens exhausted (observed ${tokenBudgetObserved}); stopping before another model turn.\n`,
      );
      const running = runningProcesses.get(ctx.runId);
      if (running) signalRunningProcess(running, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        const stillRunning = runningProcesses.get(ctx.runId);
        if (stillRunning) signalRunningProcess(stillRunning, "SIGKILL");
      }, Math.max(1, graceSec) * 1000);
    } finally {
      monitorBusy = false;
    }
  };
  const liveUsageTimer = maxTokensPerRun > 0
    ? setInterval(() => void pollLiveUsage(), liveUsagePollIntervalMs)
    : null;
  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
    }).finally(() => {
      if (liveUsageTimer) clearInterval(liveUsageTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    });
  await pollLiveUsage();

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  // Fork (2026-08-22): in-run disposition re-ask, mirroring the acpx engine.
  // Hermes lanes ended ~99% of runs without a PAPERCLIP_DISPOSITION line
  // (3 of 227 succeeded runs captured one on 2026-08-22) even though the law is
  // in their instructions — every such run costs a continuation wake and a
  // re-run. One bounded follow-up turn in the SAME session asks for the line
  // only when the main turn completed cleanly and stated nothing.
  if (
    !result.timedOut &&
    result.exitCode === 0 &&
    parsed.sessionId &&
    !extractPaperclipDisposition(parsed.response || "").disposition
  ) {
    const reaskPrompt =
      "Your previous reply did not end with the required PAPERCLIP_DISPOSITION line. " +
      "Reply with exactly ONE line and nothing else, reflecting the work you just did on this issue: " +
      'PAPERCLIP_DISPOSITION {"status":"<done|in_review|blocked|continuing>","hasBlocker":<true|false>,"blocker":"<named blocker, or empty>"}';
    const reaskArgs: string[] = ["chat", "-q", reaskPrompt, "-Q"];
    if (model) reaskArgs.push("-m", model);
    if (resolvedProvider !== "auto") reaskArgs.push("--provider", resolvedProvider);
    reaskArgs.push("--max-turns", "2", "--source", runSource, "--yolo");
    if (ignoreRules) reaskArgs.push("--ignore-rules");
    reaskArgs.push("--resume", parsed.sessionId);
    await wrappedOnLog("stdout", "[hermes] disposition re-ask: one bounded turn in the same session\n");
    const reask = await runChildProcess(ctx.runId, hermesCmd, reaskArgs, {
      cwd,
      env,
      timeoutSec: 90,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
    });
    const reaskParsed = parseHermesOutput(reask.stdout || "", reask.stderr || "");
    const reaskDisposition = extractPaperclipDisposition(reaskParsed.response || "").disposition;
    if (reaskDisposition) {
      parsed.response = `${parsed.response || ""}\n${reaskParsed.response || ""}`;
      await wrappedOnLog("stdout", `[hermes] disposition re-ask: captured ${reaskDisposition.status}\n`);
    } else {
      await wrappedOnLog("stdout", "[hermes] disposition re-ask: no disposition stated\n");
    }
  }
  const resolvedSessionId = parsed.sessionId ?? monitoredSessionId;
  const sessionUsage = resolvedSessionId
    ? await readHermesSessionUsage(resolvedSessionId) ?? monitoredUsage
    : monitoredUsage;
  tokenBudgetObserved = Math.max(tokenBudgetObserved, totalUsageTokens(sessionUsage));
  if (maxTokensPerRun > 0 && tokenBudgetObserved >= maxTokensPerRun) {
    tokenBudgetExceeded = true;
  }

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  // Lift the final-line disposition out of the response BEFORE the error
  // branches: a walled run that still delivered its lifecycle decision must
  // not be reported as having recorded none.
  const { disposition: extractedDisposition, cleanedText: cleanedResponse } =
    extractPaperclipDisposition(parsed.response || "");

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (!result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0) {
    executionResult.errorMessage = `Hermes exited with code ${result.exitCode}`;
  }

  // Silent exit: hermes died non-zero with NO diagnostic in stderr (only the
  // session_id line, if that). Measured 2026-08-18/19: hermes adapter_failed
  // runs were 4/4 silent while codex was 0/16 — the equivalent-failure breaker
  // counted these as structural and paused healthy lanes (GrowthSEO-Hermes
  // 05:04, the grok bench arm 23:5x), which is a large part of why grok quota
  // sits unused. Same class as antigravity_transient_silent_exit (TSMC-20910):
  // classify transient so the breaker ignores it and bounded retry applies.
  // A non-zero exit WITH a real stderr signature keeps adapter_failed.
  if (
    result.exitCode !== 0 &&
    result.exitCode !== null &&
    !result.timedOut &&
    !parsed.errorMessage &&
    !parsed.stopReason &&
    !tokenBudgetExceeded
  ) {
    executionResult.errorCode = "hermes_transient_silent_exit";
    executionResult.errorMessage =
      `Hermes exited ${result.exitCode} with no stderr diagnostic (transient silent exit; bounded retry, breaker-excluded).`;
  }

  if (parsed.stopReason === "max_turns_exhausted") {
    executionResult.errorCode = "max_turns_exhausted";
    executionResult.errorMessage = extractedDisposition
      ? `Hermes reached its configured maximum tool turns; the run's final-line disposition (${extractedDisposition.status}) was captured.`
      : "Hermes reached its configured maximum tool turns before recording a terminal Paperclip disposition.";
  }

  if (tokenBudgetExceeded) {
    executionResult.errorCode = "token_budget_exhausted";
    executionResult.errorMessage =
      `Hermes maxTokensPerRun budget of ${maxTokensPerRun} tokens exhausted (observed ${tokenBudgetObserved}).`;
    executionResult.clearSession = true;
  }

  if (sessionUsage || parsed.usage) {
    executionResult.usage = sessionUsage ?? parsed.usage;
    // The state database holds cumulative usage for a persisted Hermes session;
    // Paperclip derives the correct run delta before it writes usage_json.
    if (sessionUsage) executionResult.usageBasis = "session_cumulative";
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response, with the disposition line removed (it is
  // lifecycle data for resultJson, not prose for the thread).
  if (parsed.response) {
    executionResult.summary = (extractedDisposition ? cleanedResponse : parsed.response).slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: extractedDisposition ? cleanedResponse : (parsed.response || ""),
    session_id: resolvedSessionId || null,
    usage: sessionUsage ?? parsed.usage ?? null,
    cost_usd: parsed.costUsd ?? null,
    ...(extractedDisposition ? { disposition: extractedDisposition } : {}),
    ...(tokenBudgetExceeded
      ? { stopReason: "token_budget_exhausted", maxTokensPerRun, observedTokens: tokenBudgetObserved }
      : parsed.stopReason
        ? { stopReason: parsed.stopReason }
        : {}),
  };

  // Store session ID for next run
  if (persistSession && resolvedSessionId && !tokenBudgetExceeded) {
    // TSMC-21482 part 2: record the cwd the run actually executed in.
    //
    // Part 1 taught the codec to PRESERVE cwd; this supplies it. Without both,
    // the session row still lands as `{ sessionId }` only — which is exactly what
    // the first post-fix session (20260824_184548_15453e) did, and why it was
    // still going to be reset on the next run.
    //
    // TSMC-21089's convergence guard in resolveRuntimeSessionParamsForWorkspace
    // reads `previousCwd && previousCwd === projectCwd` to decide that a saved
    // session already ran in the project workspace and needs no migration. With
    // no cwd it can never converge, so "rotate once" rotates forever: hermes
    // resumed 0 of 433 runs in 24h while codex resumed 674.
    //
    // `cwd` here is the resolved execution workspace (workspaceDir ->
    // paperclipWorkspace.cwd -> config.cwd), i.e. the same directory the run
    // used — which is precisely what the guard needs to compare against.
    // Omitted when it is the "." fallback, since that proves nothing about the
    // workspace and would make the guard converge on a false match.
    const sessionCwd = cwd && cwd !== "." ? cwd : null;
    executionResult.sessionParams = {
      sessionId: resolvedSessionId,
      ...(sessionCwd ? { cwd: sessionCwd } : {}),
    };
    executionResult.sessionDisplayId = resolvedSessionId.slice(0, 16);
  }

  return executionResult;
}

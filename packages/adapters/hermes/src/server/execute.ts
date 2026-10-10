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
 *   --format           text (default) or stream-json (JSONL events, implies quiet)
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  appendWithCap,
  runChildProcess,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  selectPaperclipPromptSections,
  stringifyPaperclipWakePayload,
  isPaperclipRecoveryWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
  VALID_PROVIDERS,
  TOOL_OUTPUT_PREFIX,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";
import { reconcileHermesPaperclipSkills } from "./skills.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

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

const HERMES_RUNTIME_IDENTITY_TEMPLATE = [
  'You are "{{agent.name}}", an AI agent employee in a Paperclip-managed company.',
  "",
  "Paperclip runtime identity:",
  "- Agent ID: {{agent.id}}",
  "- Company ID: {{agent.companyId}}",
  "- Run ID: {{run.id}}",
  "- API base: {{paperclipApiUrl}}",
].join("\n");

// Hermes applies this overlay at each API call, including after compaction,
// without storing it in conversation history. Keep run/task deltas in -q.
const HERMES_SYSTEM_PROMPT_TEMPLATE = [
  "Paperclip API guidance:",
  "- Use `curl` from the terminal for Paperclip API calls; browser/web extraction tools may not reach localhost.",
  "- Use `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, and `$PAPERCLIP_RUN_ID`; do not hard-code local ports or copy secrets into comments.",
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
  "  curl -sS -X PATCH \"$api/issues/$PAPERCLIP_TASK_ID\" \\",
  "    -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \\",
  "    -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \\",
  "    -H \"Content-Type: application/json\" \\",
  "    --data-binary @-",
  "```",
  "",
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
].join("\n");

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

export function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  options: { resumedSession?: boolean } = {},
): string {
  const context = (ctx as any).context || {};
  const template = cfgString(config.promptTemplate);
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

  const { taskContextNote: taskContextMarkdown, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: options.resumedSession === true,
    includeCommunicationGuidance: true,
  });
  // Keep the historical variable available to custom templates. Automatic
  // assembly uses the ownership-aware assignment variant below.
  const paperclipTaskMarkdown = cfgString(context.paperclipTaskMarkdown)?.trim() || "";
  const sessionHandoffMarkdown = cfgString(context.paperclipSessionHandoffMarkdown)?.trim() || "";
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake) || "";

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
    taskContextMarkdown,
    paperclipWakeJson: wakePayloadJson,
    wakePayloadJson,
    paperclipApiKeyEnv: "PAPERCLIP_API_KEY",
    paperclipRunIdEnv: "PAPERCLIP_RUN_ID",
  };

  const rendered = template && !isPaperclipRecoveryWakePayload(context.paperclipWake)
    ? renderTemplate(renderConditionalSections(template, vars), vars)
    : "";
  return joinPromptSections([
    renderTemplate(HERMES_RUNTIME_IDENTITY_TEMPLATE, vars),
    wakePrompt,
    sessionHandoffMarkdown,
    taskContextMarkdown,
    rendered,
  ]);
}

// ---------------------------------------------------------------------------
// Prompt echo suppression
// ---------------------------------------------------------------------------

/**
 * Non-quiet `hermes chat -q <prompt>` prints the query straight back to stdout
 * as "<label> <prompt>" before the agent starts (hermes_cli/cli_single_query.py
 * `_run_single_query_mode`). A Paperclip prompt is tens of KB of agent
 * instructions plus the wake payload, and the UI renders unrecognized stdout as
 * assistant text — so without this the whole instruction bundle lands in the
 * chat and in the parsed response.
 *
 * Hermes prints through Rich, which re-wraps the text (sometimes mid-token) and
 * eats `[...]` spans as console markup, so the echo is not a substring of what
 * we sent. Dropping bracket spans and whitespace from both sides makes them
 * identical again, which keeps this a verified match rather than a guess.
 */
function normalizeForEchoMatch(text: string): string {
  return text.replace(/\[[^\]]*\]/g, "").replace(/[[\]\s]+/g, "");
}

/** Shorter prompts echo harmlessly; matching them is not worth the risk. */
const MIN_PROMPT_ECHO_CHARS = 200;

/** Longest localized "Query:" label we accept in front of the echo. */
const MAX_PROMPT_ECHO_LABEL_CHARS = 40;

export interface PromptEchoFilter {
  /** Filter one raw stdout chunk. Returns the text to keep. */
  (chunk: string): string;
  /** Release any held partial line. Call once the child has exited. */
  flush(): string;
}

/** Quiet runs carry no echo, so the filter would only add risk. */
export const PASS_THROUGH_ECHO_FILTER: PromptEchoFilter = Object.assign(
  (chunk: string) => chunk,
  { flush: () => "" },
);

/**
 * Offset of the prompt inside the first echo line, which also carries the
 * localized label. Returns -1 when this line cannot be the start of the echo.
 */
function promptOffsetInFirstLine(line: string, target: string): number {
  const limit = Math.min(MAX_PROMPT_ECHO_LABEL_CHARS, line.length);
  for (let offset = 0; offset <= limit; offset++) {
    const rest = line.slice(offset);
    if (rest && target.startsWith(rest)) return offset;
  }
  return -1;
}

/**
 * Build a stdout filter that drops the prompt echo and passes everything else
 * through untouched.
 *
 * Hermes writes the echo as whole lines and ends it with a newline, so the
 * filter decides one complete line at a time and holds an unterminated tail
 * until its newline arrives. Deciding on lines rather than on chunks is what
 * makes it correct for any split: a pipe can break stdout anywhere, including
 * inside the echo and between the echo and the first line of the answer.
 *
 * The filter stops at the first line that does not continue the prompt, and
 * every exit path re-emits the text it was holding. A failed match therefore
 * leaks the echo; it never swallows the answer. `flush()` covers the case where
 * the child exits while a partial line is still held.
 */
export function createPromptEchoFilter(prompt: string): PromptEchoFilter {
  const target = normalizeForEchoMatch(prompt);
  let looking = target.length >= MIN_PROMPT_ECHO_CHARS;
  let matched = 0;
  let held = "";

  /** Give up matching and return the held text from `from` onward. */
  const release = (from: number): string => {
    looking = false;
    const rest = held.slice(from);
    held = "";
    return rest;
  };

  const filter = (chunk: string): string => {
    if (!looking) return chunk;
    held += chunk;

    let consumed = 0; // raw chars of `held` confirmed to be echo
    let newline: number;
    while ((newline = held.indexOf("\n", consumed)) !== -1) {
      const line = normalizeForEchoMatch(held.slice(consumed, newline + 1));
      if (line) {
        // Nothing is confirmed until the first line matches, so a mismatch
        // there has to give back the whole buffer, blank lines included.
        const offset = matched === 0 ? promptOffsetInFirstLine(line, target) : 0;
        const rest = offset < 0 ? line : line.slice(offset);
        if (offset < 0 || !target.startsWith(rest, matched)) {
          return release(matched === 0 ? 0 : consumed);
        }
        matched += rest.length;
      }
      consumed = newline + 1;
      if (matched >= target.length) return release(consumed);
    }

    held = held.slice(consumed);
    return "";
  };

  filter.flush = () => (looking ? release(0) : "");
  return filter;
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

export interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// stream-json output
// ---------------------------------------------------------------------------

/**
 * `hermes chat -q … --format stream-json` writes one JSON event per stdout
 * line (hermes_cli/stream_json.py `StreamJsonEmitter`): a `system`/`init`
 * record, then `text` deltas and `tool_use`/`tool_result` pairs, then one
 * terminal `result` envelope carrying the session id, the final text and the
 * token counts. It forces quiet mode, so there is no banner and no prompt echo
 * — the filter above and the regexes below are both skipped for this branch.
 *
 * Opt in with `outputFormat: "stream-json"` in the adapter config. Unset, every
 * line here is inert and the text path runs exactly as before.
 */

/** Longest rendered tool input kept in a transcript line. */
const MAX_TOOL_DETAIL_CHARS = 200;

/** A stdout consumer shaped like the echo filter, plus the state it parsed. */
export interface StreamJsonConsumer extends PromptEchoFilter {
  /** Accumulated so far; final once the child has exited. */
  readonly parsed: ParsedOutput;
}

function eventNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Parallel same-name calls would collide on a name-only key, so prefer the id. */
function toolKey(event: Record<string, unknown>): string {
  const id = event.tool_call_id;
  if (typeof id === "string" && id) return id;
  return typeof event.name === "string" && event.name ? event.name : "unknown";
}

/**
 * Build a stdout consumer for `--format stream-json`.
 *
 * It returns the text to show in the Paperclip transcript — the answer's `text`
 * deltas verbatim, and one `┊` line per completed tool so the UI renders the
 * same tool card it already builds for text-mode output (src/ui/parse-stdout.ts).
 * The structured fields land in `parsed`.
 *
 * Events arrive over a pipe, which can split anywhere, so this holds an
 * unterminated tail until its newline arrives — the same line-at-a-time
 * discipline the echo filter uses. A line that is not JSON is passed through
 * untouched rather than dropped: unexpected stdout is worth seeing, and this
 * must never swallow an answer.
 */
export function createStreamJsonConsumer(): StreamJsonConsumer {
  const parsed: ParsedOutput = {};
  // Queued per key, not stored singly: the captured events carry no
  // `tool_call_id`, so two live calls to the same tool share a key and the
  // second start would otherwise overwrite the first one's input. Oldest start
  // pairs with the next completion.
  const toolInput = new Map<string, string[]>();
  let held = "";
  let sawTextDelta = false;
  /** Whether the transcript is at a fresh line; a tool card has to start one. */
  let atLineStart = true;

  const render = (event: Record<string, unknown>): string => {
    switch (event.type) {
      case "system":
        // `init` is written before credentials load, so a run that dies early
        // still reports the session it would have used.
        if (typeof event.session_id === "string" && event.session_id) {
          parsed.sessionId = event.session_id;
        }
        return "";

      case "text":
        if (typeof event.text !== "string" || !event.text) return "";
        sawTextDelta = true;
        return event.text;

      case "tool_use":
        // Held, not rendered: the card is emitted from `tool_result`, the event
        // that knows the outcome. parse-stdout.ts drops text-mode start lines
        // for the same reason.
        if (event.input !== undefined) {
          const key = toolKey(event);
          const queued = toolInput.get(key) ?? [];
          queued.push(JSON.stringify(event.input).slice(0, MAX_TOOL_DETAIL_CHARS));
          toolInput.set(key, queued);
        }
        return "";

      case "tool_result": {
        const key = toolKey(event);
        const queued = toolInput.get(key);
        const detail = queued?.shift() ?? "";
        if (queued && queued.length === 0) toolInput.delete(key);
        const name = typeof event.name === "string" && event.name ? event.name : "tool";
        const seconds = (eventNumber(event.duration_ms) / 1000).toFixed(1);
        // `[error]` goes before the duration because that is where
        // parseToolCompletionLine looks for it.
        const failed = event.is_error === true ? " [error]" : "";
        // A delta rarely ends on a newline, and the card is only read as a card
        // when `┊` opens the line — so break the line first when one is open.
        const start = atLineStart ? "" : "\n";
        return `${start}  ${TOOL_OUTPUT_PREFIX} ${name} ${detail}${failed}  ${seconds}s\n`;
      }

      case "result": {
        if (typeof event.session_id === "string" && event.session_id) {
          parsed.sessionId = event.session_id;
        }
        if (typeof event.text === "string") parsed.response = event.text;
        const tokens = event.tokens;
        if (tokens && typeof tokens === "object") {
          const counts = tokens as Record<string, unknown>;
          // UsageSummary has no cache-write field, and writing the cache is
          // billed as input, so it is counted as input here. claude-local maps
          // cacheCreationInputTokens the same way (src/server/parse.ts). Leaving
          // it out would under-report a cold run by most of its real input.
          parsed.usage = {
            inputTokens: eventNumber(counts.input) + eventNumber(counts.cache_write),
            outputTokens: eventNumber(counts.output),
            cachedInputTokens: eventNumber(counts.cache_read),
          };
        }
        // Hermes tracks `estimated_cost_usd` on its run result but does not
        // copy it into this envelope yet (stream_json.py `emit_result` forwards
        // only the token counts), so cost stays undefined against today's CLI
        // and starts working the moment that field ships. Reading the name
        // Hermes already uses keeps this a forward reference, not a guess.
        const cost = event.estimated_cost_usd;
        if (typeof cost === "number" && Number.isFinite(cost)) parsed.costUsd = cost;
        if (typeof event.error === "string" && event.error) {
          parsed.errorMessage = event.error;
        }
        // A provider that answers without streaming emits no `text` deltas;
        // without this the transcript would be empty even though the answer is
        // right here in the envelope.
        return !sawTextDelta && parsed.response ? `${parsed.response}\n` : "";
      }

      default:
        return "";
    }
  };

  /** Record where the transcript now sits, so the next tool card can open a line. */
  const emit = (piece: string): string => {
    if (piece) atLineStart = piece.endsWith("\n");
    return piece;
  };

  const consumeLine = (raw: string): string => {
    if (!raw.trim()) return "";
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return emit(raw);
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return emit(raw);
    return emit(render(event as Record<string, unknown>));
  };

  const consume = (chunk: string): string => {
    held += chunk;
    let out = "";
    let consumed = 0;
    let newline: number;
    while ((newline = held.indexOf("\n", consumed)) !== -1) {
      out += consumeLine(held.slice(consumed, newline + 1));
      consumed = newline + 1;
    }
    held = held.slice(consumed);
    return out;
  };

  consume.flush = (): string => {
    const rest = held;
    held = "";
    return rest ? consumeLine(rest) : "";
  };

  return Object.assign(consume, { parsed });
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
      if (t.startsWith("session_id:")) return false;
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

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
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

  const stderrError = extractStderrError(stderr);
  if (stderrError) result.errorMessage = stderrError;

  return result;
}

/**
 * Pull the error lines out of stderr. A Hermes crash reports itself here
 * whichever output format is in use, so both parse paths need it: stream-json
 * only learns about a failure that happened before the `result` envelope by
 * reading stderr.
 */
function extractStderrError(stderr: string): string | undefined {
  if (!stderr.trim()) return undefined;
  const errorLines = stderr
    .split("\n")
    .filter((line) => /error|exception|traceback|failed/i.test(line))
    .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
  return errorLines.length > 0 ? errorLines.slice(0, 5).join("\n") : undefined;
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
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );

  // The server adds this runtime inventory at the run boundary. Requiring the
  // marker avoids touching a developer's real Hermes home in direct unit or
  // library calls that did not opt into Paperclip runtime skills.
  if (Object.prototype.hasOwnProperty.call(config, "paperclipRuntimeSkills")) {
    try {
      const selectedSkills = await reconcileHermesPaperclipSkills(config);
      if (selectedSkills.length > 0) {
        await ctx.onLog(
          "stdout",
          `[hermes] Reconciled ${selectedSkills.length} Paperclip-managed skill(s) into the Hermes skills home.\n`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await ctx.onLog("stderr", `[hermes] Cannot start without the required Paperclip-managed skills: ${reason}\n`);
      throw err;
    }
  }

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
  // when present, reapply that bundle through Hermes's native system overlay.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let agentInstructions = "";
  if (instructionsFilePath) {
    try {
      agentInstructions = await fs.readFile(instructionsFilePath, "utf-8");
      const loadedInstructionsLength = agentInstructions.length;
      const instructionsFileDir = path.dirname(instructionsFilePath);
      agentInstructions += `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}/.`;
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
  const sessionId = persistSession ? prevSessionId : undefined;
  const prompt = buildPrompt(ctx, config, { resumedSession: Boolean(sessionId) });

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) === true; // default false
  // Opt-in JSONL events instead of human-formatted text. Unset — the default —
  // leaves the text path below untouched.
  const useStreamJson = cfgString(config.outputFormat) === "stream-json";
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

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  // Failed resumes remain failures. Do not infer a safe restart from CLI text.
  if (sessionId) args.push("--resume", sessionId);
  if (extraArgs?.length) args.push(...extraArgs);

  // Last, so it wins: argparse keeps the final `--format`, and the parse path
  // below is already committed to events. A `--format` in extraArgs must not be
  // able to leave the CLI writing text while this reads it as JSON.
  // `stream-json` forces quiet mode on the Hermes side.
  if (useStreamJson) args.push("--format", "stream-json");

  // ── Build environment ──────────────────────────────────────────────────
  const userEnv = config.env as Record<string, string> | undefined;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(userEnv && typeof userEnv === "object" ? userEnv : {}),
    ...buildPaperclipEnv(ctx.agent, ctx.agentIdentity),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };

  // Scope the overlay to this child process. Read the current bundle on every
  // invocation; never infer its availability from a persisted session ID.
  // Preserve an operator's explicit overlay before Paperclip's instructions.
  env.HERMES_EPHEMERAL_SYSTEM_PROMPT = joinPromptSections([
    env.HERMES_EPHEMERAL_SYSTEM_PROMPT,
    agentInstructions,
    renderTemplate(HERMES_SYSTEM_PROMPT_TEMPLATE, {
      agent: ctx.agent,
    }),
  ]);

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;

  // PAPERCLIP_API_KEY is never accepted from config — the harness-minted run
  // token is the only source of Paperclip API identity.
  delete env.PAPERCLIP_API_KEY;
  // Wake context travels in the prompt; drop both inherited and configured copies.
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  if ((ctx as any).authToken) env.PAPERCLIP_API_KEY = (ctx as any).authToken;

  // BUG FIX: Read task context from ctx.context (wake context), not ctx.config (adapter config)
  const ctxContext = (ctx as any).context || {};
  const envTaskId = cfgString(ctxContext.taskId) || cfgString(ctxContext.issueId) || cfgString(ctx.config?.taskId);
  if (envTaskId) env.PAPERCLIP_TASK_ID = envTaskId;
  const envWakeReason = cfgString(ctxContext.wakeReason) || cfgString(ctx.config?.wakeReason);
  if (envWakeReason) env.PAPERCLIP_WAKE_REASON = envWakeReason;
  const envCommentId = cfgString(ctxContext.commentId) || cfgString(ctxContext.wakeCommentId) || cfgString(ctx.config?.commentId);
  if (envCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = envCommentId;

  // ── Resolve working directory ──────────────────────────────────────────
  const workspace = ctx.context?.paperclipWorkspace;
  const workspaceCwd = workspace && typeof workspace === "object"
    ? cfgString((workspace as Record<string, unknown>).cwd)
    : undefined;
  const cwd =
    cfgString(config.cwd) || workspaceCwd || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (sessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${sessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout, and to drop the
  // query echo non-quiet mode writes before the agent starts. The echo has to
  // go here rather than after the run: runChildProcess streams every chunk
  // through onLog, so this is the one place that sees both the live UI
  // transcript and (via childStdout) the text the response is parsed from.
  // -Q suppresses the echo at the source, so only a non-quiet run needs the
  // filter. Running it on a quiet run could only ever discard a real answer
  // that happens to open by quoting the prompt back.
  //
  // stream-json carries no echo at all, so that branch swaps the filter for the
  // event consumer instead. Both are `(chunk) => text-to-show` with a `flush()`,
  // which is why only the one assignment below changes.
  const streamJson = useStreamJson ? createStreamJsonConsumer() : null;
  const stripPromptEcho = useQuiet || streamJson
    ? PASS_THROUGH_ECHO_FILTER
    : createPromptEchoFilter(prompt);
  const filterStdout: PromptEchoFilter = streamJson ?? stripPromptEcho;
  let childStdout = "";
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stdout") {
      const kept = filterStdout(chunk);
      if (!kept) return;
      childStdout = appendWithCap(childStdout, kept);
      return ctx.onLog("stdout", kept);
    }
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

  const result = await runChildProcess(ctx.runId, hermesCmd, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog: wrappedOnLog,
    onSpawn: ctx.onSpawn,
  });

  // The child can exit while the filter still holds an unterminated line.
  // Release it so a partial echo leaks rather than hiding a partial answer.
  const heldByFilter = filterStdout.flush();
  if (heldByFilter) {
    childStdout = appendWithCap(childStdout, heldByFilter);
    await ctx.onLog("stdout", heldByFilter);
  }

  // ── Parse output ───────────────────────────────────────────────────────
  // The events already carry everything the text path scrapes out with
  // regexes, so parseHermesOutput is skipped entirely when they are in use.
  const parsed = streamJson
    ? streamJson.parsed
    : parseHermesOutput(childStdout, result.stderr || "");
  if (streamJson && !parsed.errorMessage) {
    // No `result` envelope, or one without an error: a crash that happened
    // before Hermes could report it still shows up on stderr.
    parsed.errorMessage = extractStderrError(result.stderr || "");
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

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  } else if (!result.timedOut && typeof result.exitCode === "number" && result.exitCode !== 0) {
    executionResult.errorMessage = `Hermes exited with code ${result.exitCode}`;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  // Store session ID for next run
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  return executionResult;
}

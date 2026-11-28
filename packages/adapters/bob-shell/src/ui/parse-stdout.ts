/**
 * UI stdout line parser for IBM Bob Shell adapter.
 *
 * Bob Shell's stream-json format emits NDJSON events:
 *
 *   { "type": "message",     "role": "assistant", "content": "..." }
 *   { "type": "message",     "role": "user",      "content": "..." }
 *   { "type": "tool_use",    "tool_name": "...", "tool_id": "...", "parameters": {...} }
 *   { "type": "tool_result", "tool_id": "...", "status": "success"|"error", "output"?: "...", "error"?: "..." }
 *   { "type": "error",       "severity": "...", "message": "..." }
 *   { "type": "result",      "status": "success"|"error", "stats": {...}, "last_message": "..." }
 *
 * Lines emitted by the adapter itself start with "[bob-shell]" and are
 * rendered as system entries.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Strip ANSI escape sequences from terminal text.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

let toolCallCounter = 0;

function syntheticToolUseId(): string {
  return `bob-tool-${++toolCallCounter}`;
}

/**
 * Parse a single stdout line from Bob Shell into transcript entries.
 */
export function parseBobShellStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = stripAnsi(line).trim();
  if (!trimmed) return [];

  // ── Adapter log lines ──────────────────────────────────────────────────
  if (trimmed.startsWith("[bob-shell]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Try to parse as JSON event ─────────────────────────────────────────
  if (trimmed.startsWith("{")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not valid JSON — fall through to raw stdout
      return [{ kind: "stdout", ts, text: trimmed }];
    }

    const type = event.type;

    // message: user or assistant
    if (type === "message") {
      const role = event.role as string;
      const content =
        typeof event.content === "string" ? event.content : JSON.stringify(event.content);

      if (role === "assistant") {
        const isReasoning = event.isReasoning === true;
        if (isReasoning) {
          return [{ kind: "thinking", ts, text: content, delta: true }];
        }
        return [{ kind: "assistant", ts, text: content, delta: true }];
      }

      if (role === "user") {
        return [{ kind: "user", ts, text: content }];
      }

      return [{ kind: "stdout", ts, text: content }];
    }

    // tool_use: Bob is calling a tool
    if (type === "tool_use") {
      const toolName = typeof event.tool_name === "string" ? event.tool_name : "tool";
      const toolId =
        typeof event.tool_id === "string" ? event.tool_id : syntheticToolUseId();
      const params = event.parameters ?? {};

      return [
        {
          kind: "tool_call",
          ts,
          name: toolName,
          input: params as Record<string, unknown>,
          toolUseId: toolId,
        },
      ] as TranscriptEntry[];
    }

    // tool_result: result of a tool call
    if (type === "tool_result") {
      const toolId =
        typeof event.tool_id === "string" ? event.tool_id : syntheticToolUseId();
      const isError = event.status === "error";
      const content =
        typeof event.output === "string"
          ? event.output
          : typeof event.error === "string"
            ? event.error
            : JSON.stringify(event);

      return [
        {
          kind: "tool_result",
          ts,
          toolUseId: toolId,
          content,
          isError,
        },
      ] as TranscriptEntry[];
    }

    // error: cost/turn limit or runtime error
    if (type === "error") {
      const msg =
        typeof event.message === "string" ? event.message : JSON.stringify(event);
      const severity =
        typeof event.severity === "string" ? event.severity : "";
      return [
        {
          kind: "stderr",
          ts,
          text: severity ? `[${severity}] ${msg}` : msg,
        },
      ];
    }

    // result: terminal event with stats
    if (type === "result") {
      const status = event.status as string;
      const lastMessage =
        typeof event.last_message === "string" ? event.last_message : "";
      const stats = (event.stats ?? {}) as Record<string, unknown>;

      const parts: string[] = [];
      if (lastMessage) parts.push(lastMessage);

      const totalTokens =
        typeof stats.total_tokens === "number" ? stats.total_tokens : null;
      const durationMs =
        typeof stats.duration_ms === "number" ? stats.duration_ms : null;
      const cost =
        typeof stats.session_costs === "number" ? stats.session_costs : null;

      const statParts: string[] = [];
      if (totalTokens !== null) statParts.push(`${totalTokens} tokens`);
      if (durationMs !== null)
        statParts.push(`${(durationMs / 1000).toFixed(1)}s`);
      if (cost !== null) statParts.push(`cost: ${cost}`);

      const resultLine = [
        `Bob run ${status}`,
        ...(statParts.length > 0 ? [`(${statParts.join(", ")})`] : []),
      ].join(" ");

      const entries: TranscriptEntry[] = [];

      if (lastMessage) {
        entries.push({ kind: "assistant", ts, text: lastMessage });
      }

      entries.push({
        kind: "result",
        ts,
        text: resultLine,
        inputTokens:
          typeof stats.input_tokens === "number" ? stats.input_tokens : 0,
        outputTokens:
          typeof stats.output_tokens === "number" ? stats.output_tokens : 0,
        cachedTokens:
          typeof stats.cache_read_tokens === "number"
            ? stats.cache_read_tokens
            : 0,
        costUsd:
          typeof stats.session_costs === "number"
            ? stats.session_costs
            : undefined,
        subtype: status === "error" ? "error" : "success",
        isError: status === "error",
        errors: [],
      } as TranscriptEntry);

      return entries;
    }

    // Unknown JSON event type — render as stdout
    return [{ kind: "stdout", ts, text: trimmed }];
  }

  // ── Plain text line (pretty output mixed in) ───────────────────────────
  return [{ kind: "stdout", ts, text: trimmed }];
}

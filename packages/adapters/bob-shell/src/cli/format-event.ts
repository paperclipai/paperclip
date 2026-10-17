/**
 * CLI output formatting for IBM Bob Shell adapter.
 *
 * Pretty-prints bob run stream-json events in the terminal when running
 * Paperclip's CLI tools.
 */

import pc from "picocolors";

/**
 * Format a Bob Shell stdout event for terminal display.
 *
 * @param raw    Raw stdout line from `bob run`
 * @param debug  If true, show extra metadata with color coding
 */
export function printBobShellStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  // ── Adapter log lines ──────────────────────────────────────────────────
  if (line.startsWith("[bob-shell]")) {
    if (debug) console.log(pc.blue(line));
    return;
  }

  // ── Try to interpret JSON events ───────────────────────────────────────
  if (line.startsWith("{")) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.log(debug ? pc.gray(line) : line);
      return;
    }

    const type = event.type;

    if (type === "message") {
      const role = event.role as string;
      const content =
        typeof event.content === "string"
          ? event.content
          : JSON.stringify(event.content);
      if (role === "assistant") {
        console.log(pc.green(content));
      } else if (role === "user") {
        console.log(pc.white(content));
      } else {
        if (debug) console.log(pc.dim(content));
      }
      return;
    }

    if (type === "tool_use") {
      const toolName =
        typeof event.tool_name === "string" ? event.tool_name : "tool";
      const paramsStr = event.parameters
        ? JSON.stringify(event.parameters).slice(0, 120)
        : "";
      console.log(pc.yellow(`[tool] ${toolName}${paramsStr ? ` ${paramsStr}` : ""}`));
      return;
    }

    if (type === "tool_result") {
      const isError = event.status === "error";
      const content =
        typeof event.output === "string"
          ? event.output.slice(0, 120)
          : typeof event.error === "string"
            ? event.error.slice(0, 120)
            : "";
      if (isError) {
        console.log(pc.red(`[tool result error] ${content}`));
      } else if (debug) {
        console.log(pc.dim(`[tool result] ${content}`));
      }
      return;
    }

    if (type === "error") {
      const msg =
        typeof event.message === "string" ? event.message : JSON.stringify(event);
      const severity =
        typeof event.severity === "string" ? event.severity : "";
      console.log(pc.red(`[${severity || "error"}] ${msg}`));
      return;
    }

    if (type === "result") {
      const status = event.status as string;
      const lastMessage =
        typeof event.last_message === "string" ? event.last_message : "";
      const stats = (event.stats ?? {}) as Record<string, unknown>;
      const totalTokens =
        typeof stats.total_tokens === "number" ? ` tokens=${stats.total_tokens}` : "";
      const durationMs =
        typeof stats.duration_ms === "number"
          ? ` duration=${(stats.duration_ms / 1000).toFixed(1)}s`
          : "";
      const cost =
        typeof stats.session_costs === "number"
          ? ` cost=${stats.session_costs}`
          : "";

      const resultLine = `Bob run ${status}${totalTokens}${durationMs}${cost}`;

      if (status === "error") {
        console.log(pc.red(resultLine));
        if (lastMessage) console.log(pc.red(lastMessage));
      } else {
        console.log(pc.green(resultLine));
        if (lastMessage && debug) console.log(pc.dim(lastMessage));
      }
      return;
    }

    if (debug) {
      console.log(pc.dim(line));
    }
    return;
  }

  // ── Plain text ─────────────────────────────────────────────────────────
  console.log(debug ? pc.gray(line) : line);
}

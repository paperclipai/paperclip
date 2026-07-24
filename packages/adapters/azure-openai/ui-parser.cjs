"use strict";

/**
 * Self-contained UI transcript parser for the azure_openai adapter.
 * Follows Paperclip UI parser contract 1.x.
 *
 * The server adapter forwards raw chat-completion content deltas to
 * ctx.onLog("stdout", ...). Each line therefore represents a slice of
 * assistant text (or an error message). We render them as assistant/stderr
 * transcript entries with no special interpretation.
 */

function parseStdoutLine(line, ts) {
  if (typeof line !== "string") return [];
  const trimmed = line.replace(/\r$/, "");
  if (trimmed.length === 0) return [];

  if (
    trimmed.startsWith("Error:") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("azure_openai:")
  ) {
    return [{ kind: "stderr", ts: ts, text: trimmed }];
  }

  return [{ kind: "assistant", ts: ts, text: trimmed }];
}

module.exports = { parseStdoutLine };

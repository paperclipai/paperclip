type CodexItemCompletedEvent = {
  type?: unknown;
  item?: {
    type?: unknown;
    text?: unknown;
  };
};

function assistantTextFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const event = JSON.parse(trimmed) as CodexItemCompletedEvent;
    if (event.type !== "item.completed" || event.item?.type !== "agent_message") return null;
    return typeof event.item.text === "string" && event.item.text.trim().length > 0
      ? event.item.text.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Converts Codex JSONL stdout into user-facing assistant text. Paperclip also
 * forwards workspace preparation, adapter status, and command events on the
 * session stream; those must never leak into the chat transcript.
 */
export class AgentAnswerAccumulator {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    return lines.map(assistantTextFromLine).filter((text): text is string => Boolean(text));
  }

  finish(): string[] {
    const trailing = this.buffer;
    this.buffer = "";
    const text = assistantTextFromLine(trailing);
    return text ? [text] : [];
  }
}

import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readAssistantText(message: Record<string, unknown>): { thinking: string[]; text: string[] } {
  const content = Array.isArray(message.content) ? message.content : [];
  const thinking: string[] = [];
  const text: string[] = [];

  for (const blockRaw of content) {
    const block = asRecord(blockRaw);
    if (!block) continue;
    const type = asString(block.type);
    if (type === "thinking") {
      const value = asString(block.thinking).trim();
      if (value) thinking.push(value);
    } else if (type === "text") {
      const value = asString(block.text).trim();
      if (value) text.push(value);
    }
  }

  return { thinking, text };
}

export function printPiStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  if (type === "session") {
    const sessionId = asString(parsed.id);
    console.log(pc.blue(`pi session started${sessionId ? ` (${sessionId})` : ""}`));
    return;
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (!assistantEvent) return;
    if (asString(assistantEvent.type) === "text_delta") {
      const delta = asString(assistantEvent.delta);
      if (delta) console.log(pc.green(`assistant: ${delta}`));
    }
    return;
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    if (!message || asString(message.role) !== "assistant") return;
    const { thinking, text } = readAssistantText(message);
    for (const entry of thinking) {
      console.log(pc.gray(`thinking: ${entry}`));
    }
    for (const entry of text) {
      console.log(pc.green(`assistant: ${entry}`));
    }
    return;
  }

  if (type === "turn_end") {
    const message = asRecord(parsed.message) ?? {};
    const usage = asRecord(message.usage) ?? {};
    const cost = asRecord(usage.cost) ?? {};
    console.log(
      pc.blue(
        `tokens: in=${asNumber(usage.input)} out=${asNumber(usage.output)} cached=${asNumber(usage.cacheRead)} cost=$${asNumber(cost.total).toFixed(6)}`,
      ),
    );
    return;
  }

  if (type === "error") {
    const message = asString(parsed.message);
    console.log(pc.red(`error: ${message || line}`));
    return;
  }

  if (debug) {
    console.log(pc.gray(line));
  }
}

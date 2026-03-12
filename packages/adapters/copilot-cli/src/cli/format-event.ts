import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printCopilotStreamEvent(raw: string, _debug: boolean): void {
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

  if (type === "session.started" || type === "thread.started") {
    const sessionId = asString(parsed.session_id, asString(parsed.thread_id));
    const model = asString(parsed.model);
    const details = [
      sessionId ? `session: ${sessionId}` : "",
      model ? `model: ${model}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(pc.blue(`Copilot session started${details ? ` (${details})` : ""}`));
    return;
  }

  if (type === "message" || type === "response") {
    const text = asString(parsed.text, asString(parsed.content));
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "error") {
    const message = asString(parsed.message, asString(parsed.error));
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}

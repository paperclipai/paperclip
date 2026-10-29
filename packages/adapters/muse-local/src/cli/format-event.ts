import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printMuseStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const stream = asRecord(parsed.stream);
  if (stream?.kind === "session" && stream.id) {
    console.log(pc.blue(`Muse session: ${stream.id}`));
    return;
  }

  const payloadType = asString(parsed.payload_type).trim();
  const payload = asRecord(parsed.payload);

  if (payloadType === "run.terminal.completed" && payload?.text) {
    console.log(pc.green(asString(payload.text)));
    return;
  }

  if (payloadType === "message" || payloadType === "assistant.message") {
    const text = asString(payload?.text || payload?.content);
    if (text) {
      console.log(pc.green(`assistant: ${text}`));
      return;
    }
  }

  if (payloadType === "tool_call" || payloadType === "tool.call") {
    const name = asString(payload?.name, "tool");
    console.log(pc.yellow(`tool_call: ${name}`));
    return;
  }

  if (payloadType === "tool_result" || payloadType === "tool.result") {
    console.log(pc.cyan("tool_result"));
    return;
  }

  console.log(line);
}

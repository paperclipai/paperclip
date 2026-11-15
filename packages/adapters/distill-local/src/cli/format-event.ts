import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printDistillStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = asRecord(JSON.parse(line));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type).trim();
  if (type === "thought") {
    const text = asString(parsed.data);
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }
  if (type === "text") {
    const text = asString(parsed.data);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }
  if (type === "tool_call") {
    console.log(pc.yellow(`tool_call: ${asString(parsed.toolName) || asString(parsed.title) || "tool"}`));
    return;
  }
  if (type === "tool_call_update") {
    const status = asString(parsed.status);
    if (status === "completed" || status === "failed") {
      console.log((status === "failed" ? pc.red : pc.gray)(`tool_result: ${status}`));
    }
    return;
  }
  if (type === "end") {
    const stopReason = asString(parsed.stopReason);
    const sessionId = asString(parsed.sessionId);
    const details = [stopReason ? `stopReason=${stopReason}` : "", sessionId ? `session=${sessionId}` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(pc.blue(`Distill run completed${details ? ` (${details})` : ""}`));
    return;
  }
  if (type === "error") {
    const text = asString(parsed.message) || asString(parsed.data) || asString(asRecord(parsed.error)?.message) || "Distill error";
    console.log(pc.red(`error: ${text}`));
    return;
  }
  if (type === "usage" || type === "available_commands") return;
  console.log(pc.gray(`event: ${type || "unknown"}`));
}

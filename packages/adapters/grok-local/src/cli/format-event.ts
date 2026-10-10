import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printGrokStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
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

  if (type === "end") {
    const stopReason = asString(parsed.stopReason);
    const sessionId = asString(parsed.sessionId);
    const details = [stopReason ? `stopReason=${stopReason}` : "", sessionId ? `session=${sessionId}` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(pc.blue(`Grok run completed${details ? ` (${details})` : ""}`));
    return;
  }

  if (type === "error") {
    const text =
      asString(parsed.data) ||
      asString(parsed.message) ||
      asString(parsed.error) ||
      "Grok error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  const payload = asRecord(parsed);
  console.log(pc.gray(`event: ${type || "unknown"} ${payload ? JSON.stringify(payload) : line}`));
}

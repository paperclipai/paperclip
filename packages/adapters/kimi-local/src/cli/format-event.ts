import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printKimiStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const role = asString(parsed.role).trim();

  if (role === "assistant") {
    const rawContent = parsed.content;
    if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        const rec = asRecord(item);
        if (!rec) continue;
        const type = asString(rec.type).trim();
        if (type === "text") {
          const text = asString(rec.text);
          if (text) console.log(pc.green(`assistant: ${text}`));
        } else if (type === "think") {
          const text = asString(rec.think);
          if (text) console.log(pc.gray(`thinking: ${text}`));
        }
      }
    } else {
      const content = asString(parsed.content);
      if (content) console.log(pc.green(`assistant: ${content}`));
    }
    return;
  }

  if (role === "tool") {
    const rawContent = parsed.content;
    const toolCallId = asString(parsed.tool_call_id);
    const prefix = toolCallId ? `[tool ${toolCallId}] ` : "[tool] ";
    let content = "";
    if (Array.isArray(rawContent)) {
      const texts: string[] = [];
      for (const item of rawContent) {
        const rec = asRecord(item);
        if (!rec) continue;
        const type = asString(rec.type).trim();
        if (type === "text") {
          const text = asString(rec.text);
          if (text) texts.push(text);
        }
      }
      content = texts.join("");
    } else {
      content = asString(rawContent);
    }
    if (content) console.log(pc.cyan(`${prefix}${content}`));
    return;
  }

  if (role === "error") {
    const text = asString(parsed.content) || asString(parsed.message) || "Kimi error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  const payload = asRecord(parsed);
  console.log(pc.gray(`event: ${role || "unknown"} ${payload ? JSON.stringify(payload) : line}`));
}

import pc from "picocolors";
import { printAcpxStreamEvent } from "@paperclipai/adapter-utils/acpx-engine/cli";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

  if (asString(parsed.type).startsWith("acpx.")) {
    printAcpxStreamEvent(line, _debug);
    return;
  }

  const role = asString(parsed.role).trim().toLowerCase();

  if (role === "assistant") {
    const content = asString(parsed.content).trim();
    if (content) console.log(pc.green(`assistant: ${content}`));
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [];
    for (const callRaw of toolCalls) {
      const call = asRecord(callRaw);
      if (!call) continue;
      const fn = asRecord(call.function);
      const name = asString(fn?.name, asString(call.name, "tool")).trim() || "tool";
      console.log(pc.yellow(`tool_call: ${name}`));
      const argsRaw = fn?.arguments ?? call.arguments;
      if (argsRaw === undefined) continue;
      if (typeof argsRaw === "string") {
        try {
          console.log(pc.gray(stringifyUnknown(JSON.parse(argsRaw))));
        } catch {
          console.log(pc.gray(argsRaw));
        }
      } else {
        console.log(pc.gray(stringifyUnknown(argsRaw)));
      }
    }
    return;
  }

  if (role === "tool") {
    console.log(pc.cyan("tool_result"));
    const content = asString(parsed.content) || stringifyUnknown(parsed.content);
    if (content) console.log(pc.gray(content));
    return;
  }

  if (role === "meta") {
    const type = asString(parsed.type).trim();
    if (type === "session.resume_hint") {
      const sessionId = asString(parsed.session_id).trim();
      if (sessionId) console.log(pc.blue(`Kimi session: ${sessionId}`));
    }
    return;
  }

  if (role === "error" || asString(parsed.type).trim().toLowerCase() === "error") {
    const text =
      asString(parsed.content) ||
      asString(parsed.message) ||
      asString(parsed.error) ||
      "Kimi error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(line);
}

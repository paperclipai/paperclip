import pc from "picocolors";

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickToolUseId(parsed: Record<string, unknown>): string {
  return (
    asString(parsed.toolCallId) ||
    asString(parsed.toolUseId) ||
    asString(parsed.id)
  );
}

function statusLine(parsed: Record<string, unknown>): string {
  const text = asString(parsed.text).trim();
  const tag = asString(parsed.tag).trim();
  const used = asNumber(parsed.used, -1);
  const size = asNumber(parsed.size, -1);
  const parts: string[] = [];
  if (text) parts.push(text);
  if (tag && !text) parts.push(tag);
  if (used >= 0 && size > 0) parts.push(`(${used}/${size} ctx)`);
  return parts.join(" ") || tag || "status";
}

export function printAcpxStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const parsed = parseJson(line);
  if (!parsed) {
    if (debug) console.log(pc.gray(line));
    else console.log(line);
    return;
  }

  const type = asString(parsed.type);
  if (type === "acpx.session") {
    const agent = asString(parsed.agent, "acpx");
    const session =
      asString(parsed.acpSessionId) ||
      asString(parsed.sessionId) ||
      asString(parsed.runtimeSessionName);
    const mode = asString(parsed.mode);
    const permissionMode = asString(parsed.permissionMode);
    const tail = [mode, permissionMode].filter(Boolean).join(" / ");
    const suffix = tail ? ` [${tail}]` : "";
    console.log(pc.blue(`${agent} session${session ? `: ${session}` : ""}${suffix}`));
    return;
  }
  if (type === "acpx.text_delta") {
    const text = asString(parsed.text);
    if (!text) return;
    const channel = asString(parsed.channel) || asString(parsed.stream);
    const isThought = channel === "thought" || channel === "thinking";
    if (isThought) console.log(pc.gray(text));
    else process.stdout.write(pc.green(text));
    return;
  }
  if (type === "acpx.tool_call") {
    const name = asString(parsed.name, "acp_tool");
    const status = asString(parsed.status);
    const id = pickToolUseId(parsed);
    const header = status ? `tool_call: ${name} [${status}]` : `tool_call: ${name}`;
    const idSuffix = id ? ` (${id})` : "";
    const isError = status === "failed" || status === "cancelled";
    console.log((isError ? pc.red : pc.yellow)(`${header}${idSuffix}`));
    if (parsed.input !== undefined) {
      console.log(pc.gray(stringify(parsed.input)));
    } else {
      const text = asString(parsed.text).trim();
      if (text) console.log(pc.gray(text));
    }
    return;
  }
  if (type === "acpx.tool_result") {
    const isError = parsed.isError === true || parsed.error !== undefined;
    console.log((isError ? pc.red : pc.cyan)(`tool_result: ${asString(parsed.name, "acp_tool")}`));
    const content = stringify(parsed.content ?? parsed.output ?? parsed.error);
    if (content) console.log((isError ? pc.red : pc.gray)(content));
    return;
  }
  if (type === "acpx.status") {
    console.log(pc.gray(`status: ${statusLine(parsed)}`));
    return;
  }
  if (type === "acpx.result") {
    const summary = asString(parsed.summary, asString(parsed.stopReason, asString(parsed.subtype, "complete")));
    console.log(pc.blue(`result: ${summary}`));
    return;
  }
  if (type === "acpx.error") {
    console.log(pc.red(`error: ${asString(parsed.message, line)}`));
    return;
  }
  console.log(debug ? pc.gray(line) : line);
}

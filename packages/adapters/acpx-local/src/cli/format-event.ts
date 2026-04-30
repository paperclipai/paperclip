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

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
    const session = asString(parsed.sessionId, asString(parsed.acpSessionId));
    console.log(pc.blue(`${agent} session${session ? `: ${session}` : ""}`));
    return;
  }
  if (type === "acpx.text_delta") {
    const text = asString(parsed.text);
    if (text) console.log(asString(parsed.channel) === "thought" ? pc.gray(text) : pc.green(text));
    return;
  }
  if (type === "acpx.tool_call") {
    console.log(pc.yellow(`tool_call: ${asString(parsed.name, "acp_tool")}`));
    if (parsed.input !== undefined) console.log(pc.gray(stringify(parsed.input)));
    return;
  }
  if (type === "acpx.tool_result") {
    const isError = parsed.isError === true || parsed.error !== undefined;
    console.log((isError ? pc.red : pc.cyan)(`tool_result: ${asString(parsed.name, "acp_tool")}`));
    const content = stringify(parsed.content ?? parsed.output ?? parsed.error);
    if (content) console.log((isError ? pc.red : pc.gray)(content));
    return;
  }
  if (type === "acpx.result") {
    console.log(pc.blue(`result: ${asString(parsed.summary, asString(parsed.subtype, "complete"))}`));
    return;
  }
  if (type === "acpx.error") {
    console.log(pc.red(`error: ${asString(parsed.message, line)}`));
    return;
  }
  console.log(debug ? pc.gray(line) : line);
}

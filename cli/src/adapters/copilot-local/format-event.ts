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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseResultText(resultRaw: unknown): string {
  if (typeof resultRaw === "string") return resultRaw;
  const result = asRecord(resultRaw);
  if (!result) return stringifyUnknown(resultRaw);
  return (
    asString(result.detailedContent) ||
    asString(result.content) ||
    asString(result.message) ||
    asString(result.error) ||
    stringifyUnknown(result)
  );
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
  const data = asRecord(parsed.data);

  if (type === "assistant.message") {
    const text = asString(data?.content).trim();
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "assistant.reasoning") {
    const text = asString(data?.content).trim();
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "tool.execution_start") {
    console.log(pc.yellow(`tool_call: ${asString(data?.toolName, "tool")}`));
    const args = data?.arguments;
    if (args !== undefined) console.log(pc.gray(stringifyUnknown(args)));
    return;
  }

  if (type === "tool.execution_complete") {
    const isError = data?.success === false;
    console.log((isError ? pc.red : pc.cyan)(`tool_result: ${asString(data?.toolName, "tool")}`));
    const text = parseResultText(data?.result);
    if (text) console.log((isError ? pc.red : pc.gray)(text));
    return;
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage);
    const exitCode = asNumber(parsed.exitCode, 0);
    const premiumRequests = typeof usage?.premiumRequests === "number" ? usage.premiumRequests : null;
    const summary = [
      `exit_code=${exitCode}`,
      premiumRequests !== null ? `premium_requests=${premiumRequests}` : "",
    ].filter(Boolean).join(" ");
    console.log((exitCode === 0 ? pc.blue : pc.red)(`result: ${summary}`));
    return;
  }

  if (type === "session.tools_updated") {
    const model = asString(data?.model).trim();
    if (model) console.log(pc.blue(`model: ${model}`));
    return;
  }

  if (type === "user.message") {
    const text = asString(data?.content).trim();
    if (text) console.log(pc.gray(`user: ${text}`));
    return;
  }

  console.log(line);
}

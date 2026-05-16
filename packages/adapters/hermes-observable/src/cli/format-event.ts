import pc from "picocolors";
import { HERMES_OBSERVABLE_EVENT_TYPES } from "../shared/constants.js";

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

export function printHermesObservableStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (line.startsWith("[hermes]")) {
    console.log(pc.blue(line));
    return;
  }

  const parsed = parseJson(line);
  if (!parsed) {
    console.log(debug ? pc.gray(line) : line);
    return;
  }

  const type = asString(parsed.type);
  if (type === HERMES_OBSERVABLE_EVENT_TYPES.init) {
    console.log(pc.blue(`Hermes observable initialized (${asString(parsed.endpointMode, "unknown")})`));
    return;
  }
  if (type === HERMES_OBSERVABLE_EVENT_TYPES.textDelta) {
    console.log(pc.green(`assistant: ${asString(parsed.text)}`));
    return;
  }
  if (type === HERMES_OBSERVABLE_EVENT_TYPES.toolCall) {
    console.log(pc.yellow(`tool_call: ${asString(parsed.name, "tool")}`));
    const input = stringify(parsed.input);
    if (input) console.log(pc.gray(input));
    return;
  }
  if (type === HERMES_OBSERVABLE_EVENT_TYPES.toolResult) {
    console.log((parsed.isError === true ? pc.red : pc.cyan)(`tool_result: ${asString(parsed.name, "tool")}`));
    const content = stringify(parsed.content);
    if (content) console.log((parsed.isError === true ? pc.red : pc.gray)(content));
    return;
  }
  if (type === HERMES_OBSERVABLE_EVENT_TYPES.result) {
    console.log(pc.green("result:"));
    console.log(asString(parsed.text));
    return;
  }
  if (type === HERMES_OBSERVABLE_EVENT_TYPES.error) {
    console.log(pc.red(asString(parsed.message, line)));
    return;
  }

  console.log(debug ? pc.gray(line) : line);
}

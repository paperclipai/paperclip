import { ZAI_STDOUT_PREFIX } from "../shared/types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function printZaiStreamEvent(line: string, debug: boolean): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith(ZAI_STDOUT_PREFIX)) {
    if (debug) process.stdout.write(`${line}\n`);
    return;
  }
  const rest = trimmed.slice(ZAI_STDOUT_PREFIX.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest);
  } catch {
    if (debug) process.stdout.write(`${line}\n`);
    return;
  }
  const record = asRecord(parsed);
  if (!record) return;

  const kind = typeof record.kind === "string" ? record.kind : "";
  switch (kind) {
    case "assistant_delta":
      if (typeof record.text === "string") process.stdout.write(record.text);
      return;
    case "assistant_final":
      if (typeof record.text === "string" && !debug) process.stdout.write("\n");
      return;
    case "tool_call":
      process.stdout.write(
        `\n[tool_call ${String(record.name)}] ${JSON.stringify(record.input)}\n`,
      );
      return;
    case "usage":
      if (debug) {
        process.stdout.write(
          `\n[usage] input=${record.inputTokens} output=${record.outputTokens}${record.cachedTokens ? ` cached=${record.cachedTokens}` : ""}\n`,
        );
      }
      return;
    case "error":
      process.stderr.write(`[error] ${record.message}\n`);
      return;
    default:
      if (debug) process.stdout.write(`${line}\n`);
  }
}

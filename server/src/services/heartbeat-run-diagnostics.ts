import { appendWithByteCap, MAX_EXCERPT_BYTES, parseObject, parseJson } from "../adapters/utils.js";

type StreamName = "stdout" | "stderr";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function appendDistinctExcerpt(current: string | null | undefined, next: string | null) {
  const existing = current ?? "";
  if (!next) return existing;
  const normalized = next.endsWith("\n") ? next : `${next}\n`;
  if (existing.includes(next) || existing.includes(normalized)) return existing;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return appendWithByteCap(`${existing}${separator}`, normalized, MAX_EXCERPT_BYTES);
}

function readStream(resultJson: Record<string, unknown> | null | undefined, stream: StreamName) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  return readNonEmptyString(resultJson[stream]);
}

function readCodexFailureEventType(stdout: string | null) {
  if (!stdout) return null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    const type = readNonEmptyString(event.type);
    if (type === "turn.failed" || type === "error") return type;
  }
  return null;
}

export function readHeartbeatRunFailureSubtype(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;

  const direct =
    readNonEmptyString(resultJson.failureSubtype) ??
    readNonEmptyString(resultJson.subtype) ??
    readNonEmptyString(resultJson.type);
  if (direct) return direct;

  const error = parseObject(resultJson.error);
  const errorType = readNonEmptyString(error.type) ?? readNonEmptyString(error.code);
  if (errorType) return errorType;

  return readCodexFailureEventType(readStream(resultJson, "stdout"));
}

export function mergeHeartbeatRunDiagnosticEvidence(input: {
  resultJson: Record<string, unknown> | null | undefined;
  stdoutExcerpt: string | null | undefined;
  stderrExcerpt: string | null | undefined;
  failureSubtype?: string | null;
}) {
  const resultJson =
    input.resultJson && typeof input.resultJson === "object" && !Array.isArray(input.resultJson)
      ? input.resultJson
      : null;
  const failureSubtype = input.failureSubtype ?? readHeartbeatRunFailureSubtype(resultJson);
  return {
    stdoutExcerpt: appendDistinctExcerpt(input.stdoutExcerpt, readStream(resultJson, "stdout")),
    stderrExcerpt: appendDistinctExcerpt(input.stderrExcerpt, readStream(resultJson, "stderr")),
    resultJson: resultJson && failureSubtype ? { ...resultJson, failureSubtype } : resultJson,
  };
}

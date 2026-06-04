/**
 * Terminal formatter for `paperclipai run --watch` output.
 *
 * Receives raw stdout/stderr lines from the subprocess (forwarded by the
 * server's ChildProcessFactory via paperclip's onLog). Detects whether the
 * line is:
 *   - the §4.1 envelope (one JSON object at end of stdout)
 *   - a wire-protocol notification (NDJSON event on stderr)
 *   - non-JSON noise (printed through dim)
 *
 * Color scheme is consistent with codex-local's printer:
 *   blue   — init / structural events
 *   green  — assistant text (final reply)
 *   gray   — thinking / reasoning
 *   yellow — tool calls (in-flight)
 *   cyan   — tool results
 *   red    — errors / failures
 */

import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

function looksLikeEnvelope(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.protocolVersion === "string" &&
    typeof obj.sessionId === "string" &&
    typeof obj.turnId === "string" &&
    "reply" in obj &&
    "metadata" in obj
  );
}

function printEnvelope(obj: Record<string, unknown>): void {
  const errorBlock = asRecord(obj.error);
  const metadata = asRecord(obj.metadata) ?? {};
  if (errorBlock) {
    console.log(
      pc.red(
        `[envelope] error: ${asString(errorBlock.code, "(no code)")} — ${asString(errorBlock.message, "")}`,
      ),
    );
  } else {
    const reply = asString(obj.reply, "");
    console.log(pc.green(`[final] ${reply}`));
  }
  const tokensIn = asNumber(metadata.tokensIn);
  const tokensOut = asNumber(metadata.tokensOut);
  const durationMs = asNumber(metadata.durationMs);
  console.log(
    pc.blue(
      `[metadata] tokens=${tokensIn}/${tokensOut} duration=${durationMs}ms engine=${asString(metadata.engineVersion)}`,
    ),
  );
}

function printNotification(method: string, params: Record<string, unknown>): void {
  switch (method) {
    case "result/delta":
      process.stdout.write(pc.green(asString(params.text, "")));
      break;
    case "result/final":
      console.log(pc.green(`[result/final] ${asString(params.text, "")}`));
      break;
    case "tool/started":
      console.log(
        pc.yellow(
          `[tool/started] ${asString(params.name, "<tool>")} ${
            params.args ? JSON.stringify(params.args) : ""
          }`,
        ),
      );
      break;
    case "tool/completed": {
      const result = params.result;
      const out =
        typeof result === "string"
          ? result
          : result != null
            ? JSON.stringify(result)
            : "";
      console.log(
        pc.cyan(
          `[tool/completed] ${asString(params.name, "<tool>")} → ${out.slice(0, 200)}`,
        ),
      );
      break;
    }
    case "thinking/delta":
      process.stdout.write(pc.gray(asString(params.text, "")));
      break;
    case "thinking/final":
      console.log(pc.gray(`[thinking] ${asString(params.text, "")}`));
      break;
    case "progress": {
      const percent = typeof params.percent === "number" ? params.percent : null;
      console.log(
        pc.blue(
          `[progress] ${asString(params.message, "")}${percent !== null ? ` (${percent.toFixed(0)}%)` : ""}`,
        ),
      );
      break;
    }
    case "usage":
      console.log(
        pc.blue(
          `[usage] in=${asNumber(params.inputTokens)} out=${asNumber(params.outputTokens)}`,
        ),
      );
      break;
    case "error":
      console.log(
        pc.red(
          `[error] ${asString(params.code, "")}: ${asString(params.message, "")}`,
        ),
      );
      break;
    default:
      console.log(
        pc.gray(`[${method}] ${JSON.stringify(params).slice(0, 200)}`),
      );
  }
}

export function printAmplifierLocalStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const parsed = safeJsonParse(line);
  const obj = asRecord(parsed);
  if (!obj) {
    // Non-JSON noise — engine startup/shutdown messages. Dim to stay out of the way.
    console.log(pc.dim(line));
    return;
  }
  if (looksLikeEnvelope(obj)) {
    printEnvelope(obj);
    return;
  }
  const method = asString(obj.method) || asString(obj.type);
  if (method) {
    const params = asRecord(obj.params) ?? {};
    printNotification(method, params);
    return;
  }
  // Unknown JSON shape — show raw.
  console.log(pc.dim(line));
}

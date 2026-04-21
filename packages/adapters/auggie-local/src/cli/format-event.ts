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

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Auggie's `--print --output-format json` mode emits a single JSON object on
 * stdout (optionally preceded by plain-text preamble lines). We print the
 * preamble verbatim and summarize the result object as a structured line.
 */
export function printAuggieStreamEvent(raw: string, _debug: boolean): void {
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

  if (type === "result") {
    const sessionId =
      asString(parsed.session_id) ||
      asString(parsed.sessionId) ||
      asString(parsed.sessionID);
    const subtype = asString(parsed.subtype, "result");
    const isError = parsed.is_error === true;
    const numTurns = asNumber(parsed.num_turns, 0);
    const resultText = asString(parsed.result, "").trim();
    if (resultText) console.log(pc.green(`assistant: ${resultText}`));
    const details = [
      `subtype=${subtype}`,
      `is_error=${isError ? "true" : "false"}`,
      `turns=${numTurns}`,
      sessionId ? `session=${sessionId}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log((isError ? pc.red : pc.blue)(`result: ${details}`));
    return;
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    if (text) console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(line);
}

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

export function printGeminiStreamEvent(raw: string, _debug: boolean): void {
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

  if (type === "init") {
    const sessionId = asString(parsed.session_id);
    const model = asString(parsed.model);
    const details = [sessionId ? `session: ${sessionId}` : "", model ? `model: ${model}` : ""].filter(Boolean).join(", ");
    console.log(pc.blue(`Gemini session started${details ? ` (${details})` : ""}`));
    return;
  }

  if (type === "message") {
    const role = asString(parsed.role);
    const content = asString(parsed.content);
    if (role === "assistant" && content) {
      console.log(pc.green(`assistant: ${content}`));
    }
    return;
  }

  if (type === "tool_call") {
    const name = asString(parsed.name, "unknown");
    console.log(pc.yellow(`tool_call: ${name}`));
    if (parsed.input !== undefined) {
      try {
        console.log(pc.gray(JSON.stringify(parsed.input, null, 2)));
      } catch {
        console.log(pc.gray(String(parsed.input)));
      }
    }
    return;
  }

  if (type === "tool_result") {
    const isError = parsed.is_error === true;
    const output = asString(parsed.output, asString(parsed.content, ""));
    console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
    if (output) console.log((isError ? pc.red : pc.gray)(output));
    return;
  }

  if (type === "error") {
    const message = asString(parsed.message, asString(parsed.error, ""));
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  if (type === "result") {
    const stats = asRecord(parsed.stats);
    const input = asNumber(stats?.input_tokens, asNumber(stats?.input, 0));
    const output = asNumber(stats?.output_tokens, 0);
    const cached = asNumber(stats?.cached, 0);
    const duration = asNumber(stats?.duration_ms, 0);
    const status = asString(parsed.status);
    console.log(
      pc.blue(`tokens: in=${input} out=${output} cached=${cached} duration=${duration}ms status=${status}`),
    );
    return;
  }

  console.log(line);
}

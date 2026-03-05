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

function printToolEvent(part: Record<string, unknown>): void {
  const tool = asString(part.tool, "tool");
  const callId = asString(part.callID, asString(part.id, ""));
  const state = asRecord(part.state);
  const status = asString(state?.status);
  const input = state?.input;
  const output = asString(state?.output).replace(/\s+$/, "");
  const metadata = asRecord(state?.metadata);
  const exit = asNumber(metadata?.exit, NaN);
  const isError =
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    (Number.isFinite(exit) && exit !== 0);

  console.log(pc.yellow(`tool_call: ${tool}${callId ? ` (${callId})` : ""}`));
  if (input !== undefined) {
    try {
      console.log(pc.gray(JSON.stringify(input, null, 2)));
    } catch {
      console.log(pc.gray(String(input)));
    }
  }

  if (status || output) {
    const summary = [
      "tool_result",
      status ? `status=${status}` : "",
      Number.isFinite(exit) ? `exit=${exit}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log((isError ? pc.red : pc.cyan)(summary));
    if (output) {
      console.log((isError ? pc.red : pc.gray)(output));
    }
  }
}

export function printOpenCodeStreamEvent(raw: string, _debug: boolean): void {
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

  if (type === "step_start") {
    const sessionId = asString(parsed.sessionID);
    console.log(pc.blue(`step started${sessionId ? ` (session: ${sessionId})` : ""}`));
    return;
  }

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "tool_use") {
    const part = asRecord(parsed.part);
    if (part) {
      printToolEvent(part);
    } else {
      console.log(pc.yellow("tool_use"));
    }
    return;
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens);
    const cache = asRecord(tokens?.cache);
    const reason = asString(part?.reason, "step_finish");
    const input = asNumber(tokens?.input);
    const output = asNumber(tokens?.output);
    const cached = asNumber(cache?.read);
    const cost = asNumber(part?.cost);
    console.log(pc.blue(`step finished: reason=${reason}`));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
    return;
  }

  if (type === "error") {
    const part = asRecord(parsed.part);
    const message = asString(parsed.message) || asString(part?.message) || line;
    console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}

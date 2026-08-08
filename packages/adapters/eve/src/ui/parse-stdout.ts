import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readText(data: Record<string, unknown> | null, keys: string[]): string {
  if (!data) return "";
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function parseEveEvent(eventRaw: unknown, ts: string): TranscriptEntry[] {
  const event = asRecord(eventRaw);
  if (!event) return [];
  const type = asString(event.type);
  const data = asRecord(event.data);

  if (type === "message.appended") {
    const text = readText(data, ["delta", "text"]);
    return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
  }

  if (type === "message.completed") {
    const text = readText(data, ["text", "cumulativeText", "content"]).trim();
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "reasoning.appended") {
    const text = readText(data, ["delta", "text"]);
    return text ? [{ kind: "thinking", ts, text, delta: true }] : [];
  }

  if (type === "reasoning.completed") {
    const text = readText(data, ["text", "cumulativeText"]).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "actions.requested") {
    const actions = Array.isArray(data?.actions) ? data.actions : data ? [data] : [];
    const entries: TranscriptEntry[] = [];
    for (const actionRaw of actions) {
      const action = asRecord(actionRaw);
      if (!action) continue;
      entries.push({
        kind: "tool_call",
        ts,
        name: asString(action.name, asString(action.tool, "action")),
        toolUseId: asString(action.id, asString(action.actionId)) || undefined,
        input: action.input ?? action.arguments ?? {},
      });
    }
    return entries;
  }

  if (type === "action.result") {
    const toolUseId =
      asString(data?.id, asString(data?.actionId, asString(data?.callId))) || "action";
    const isError = data?.isError === true || asString(data?.status).toLowerCase() === "error";
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId,
        toolName: asString(data?.name, asString(data?.tool)) || undefined,
        content: stringifyUnknown(data?.result ?? data?.output ?? data?.error ?? {}),
        isError,
      },
    ];
  }

  if (type === "input.requested") {
    const prompt = readText(data, ["prompt", "message", "question"]).trim();
    return [
      {
        kind: "system",
        ts,
        text: `Agent is waiting for human input${prompt ? `: ${prompt}` : ""}`,
      },
    ];
  }

  if (type === "step.failed" || type === "turn.failed" || type === "session.failed") {
    const message = readText(data, ["message"]).trim() || `${type}`;
    const code = readText(data, ["code"]).trim();
    return [
      {
        kind: "stderr",
        ts,
        text: `${type}${code ? ` [${code}]` : ""}: ${message}`,
      },
    ];
  }

  // Lifecycle noise (session.started, turn.started, step.started,
  // message.received, session.waiting, session.completed, turn.completed,
  // step.completed) and unknown event types are omitted from the transcript.
  return [];
}

export function parseEveStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "eve.init") {
    return [
      {
        kind: "init",
        ts,
        model: asString(parsed.model, "eve"),
        sessionId: asString(parsed.sessionId),
      },
    ];
  }

  if (type === "eve.event") {
    return parseEveEvent(parsed.event, ts);
  }

  if (type === "eve.result") {
    const status = asString(parsed.status, "error");
    const isError =
      status === "error" ||
      status === "timed_out" ||
      status === "session.failed" ||
      status === "turn.failed";
    return [
      {
        kind: "result",
        ts,
        text: asString(parsed.summary),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: status,
        isError,
        errors: parsed.error ? [asString(parsed.error)] : [],
      },
    ];
  }

  return [{ kind: "stdout", ts, text: line }];
}

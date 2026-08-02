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

function parseApiEvent(eventRaw: unknown, ts: string): TranscriptEntry[] {
  const event = asRecord(eventRaw);
  if (!event) return [];
  const type = asString(event.type);
  const part = asRecord(event.part);

  if (type === "agent.message") {
    const text = asString(event.text).trim();
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "agent.reasoning") {
    const text = asString(part?.text).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "agent.tool_use") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(part?.tool_name, "tool"),
      toolUseId: asString(event.id) || undefined,
      input: part?.args ?? {},
    }];
  }

  if (type === "agent.tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(event.id, "tool_result"),
      toolName: asString(part?.tool_name, "tool"),
      content: stringifyUnknown(part?.text ?? part ?? {}),
      isError: asString(part?.status).toLowerCase() === "error",
    }];
  }

  if (type === "agent.status") {
    const text = asString(part?.text).trim();
    const level = asString(part?.level).trim();
    return text ? [{ kind: "system", ts, text: `${level ? `${level}: ` : ""}${text}` }] : [];
  }

  if (type === "user.message") {
    // The adapter's own wake prompt echoes back as an api-channel user
    // message; repeating it in the transcript would drown the run output.
    return [];
  }

  if (type === "error") {
    const text = asString(event.message, asString(event.code, "unknown error"));
    return [{ kind: "stderr", ts, text: `error: ${text}` }];
  }

  return [];
}

export function parseAgentskyCloudStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  if (type === "agentsky_cloud.init") {
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, "agentsky_cloud"),
      sessionId: asString(parsed.sessionId),
    }];
  }

  if (type === "agentsky_cloud.status") {
    return [{
      kind: "system",
      ts,
      text: `${asString(parsed.status, "status")}${parsed.message ? `: ${asString(parsed.message)}` : ""}`,
    }];
  }

  if (type === "agentsky_cloud.message") {
    return parseApiEvent(parsed.event, ts);
  }

  if (type === "agentsky_cloud.result") {
    const status = asString(parsed.status, "error");
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result),
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: status,
      isError: status !== "finished",
      errors: parsed.error ? [asString(parsed.error)] : [],
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

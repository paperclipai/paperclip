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

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => (entry.type === "text" ? asString(entry.text) : `[${asString(entry.type, "content")}]`))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseQoderEvent(eventRaw: unknown, ts: string): TranscriptEntry[] {
  const event = asRecord(eventRaw);
  if (!event) return [];
  const type = asString(event.type);

  if (type === "agent.message") {
    const text = contentText(event.content);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "agent.tool_use" || type === "agent.mcp_tool_use" || type === "agent.custom_tool_use") {
    const server = asString(event.mcp_server_name);
    const name = asString(event.name, "tool");
    return [{
      kind: "tool_call",
      ts,
      name: server ? `${server}/${name}` : name,
      toolUseId: asString(event.id) || undefined,
      input: event.input ?? {},
    }];
  }

  if (type === "agent.tool_result" || type === "agent.mcp_tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: asString(event.tool_use_id, asString(event.mcp_tool_use_id, asString(event.id, "tool_result"))),
      content: contentText(event.content) || stringifyUnknown(event.content ?? ""),
      isError: event.is_error === true,
    }];
  }

  if (type === "agent.thread_message_received") {
    const text = contentText(event.content);
    const from = asString(event.from_agent_name, "agent");
    return text ? [{ kind: "system", ts, text: `${from}: ${text}` }] : [];
  }

  if (type === "agent.artifact_delivered") {
    return [{
      kind: "system",
      ts,
      text: `artifact delivered: ${asString(event.original_filename, asString(event.file_id, "file"))}`,
    }];
  }

  if (type === "agent.thread_context_compacted") {
    return [{ kind: "system", ts, text: "context compacted" }];
  }

  if (type === "session.error") {
    const error = asRecord(event.error);
    const retry = asString(asRecord(error?.retry_status)?.type);
    const message = asString(error?.message, asString(error?.type, "Qoder session error"));
    return [{ kind: "stderr", ts, text: retry ? `${message} (${retry})` : message }];
  }

  if (type === "session.status_idle") {
    const stopReason = asString(asRecord(event.stop_reason)?.type);
    return [{ kind: "system", ts, text: `idle${stopReason ? `: ${stopReason}` : ""}` }];
  }

  if (type === "session.status_rescheduled") return [{ kind: "system", ts, text: "rescheduled" }];
  if (type === "session.status_terminated") return [{ kind: "system", ts, text: "terminated" }];
  if (type === "session.deleted") return [{ kind: "system", ts, text: "session deleted" }];

  // The prompt is already recorded as invocation metadata; thinking events carry no content.
  return [];
}

export function parseQoderCloudAgentsStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  if (type === "qoder_cloud_agents.init") {
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, "qoder_cloud_agents"),
      sessionId: asString(parsed.sessionId),
    }];
  }

  if (type === "qoder_cloud_agents.status") {
    return [{
      kind: "system",
      ts,
      text: `${asString(parsed.status, "status")}${parsed.message ? `: ${asString(parsed.message)}` : ""}`,
    }];
  }

  if (type === "qoder_cloud_agents.event") {
    return parseQoderEvent(parsed.event, ts);
  }

  if (type === "qoder_cloud_agents.result") {
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

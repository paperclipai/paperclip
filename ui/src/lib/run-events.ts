import type { HeartbeatRunEvent } from "@paperclipai/shared";
import type { TranscriptEntry } from "../adapters";

const STRUCTURED_TRANSCRIPT_EVENT_TYPES = new Set([
  "assistant.message",
  "assistant.thinking",
  "user.message",
  "tool.call",
  "tool.result",
  "command.execution.started",
  "command.execution.completed",
  "adapter.session.init",
  "adapter.result",
  "transcript.system",
  "transcript.stdout",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function commandExecutionContent(payload: Record<string, unknown>, fallback: string) {
  const lines: string[] = [];
  const command = asString(payload.command);
  const status = asString(payload.status);
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
  const outputSnippet = asString(payload.outputSnippet);

  if (command) lines.push(`command: ${command}`);
  if (status) lines.push(`status: ${status}`);
  if (exitCode !== null) lines.push(`exit_code: ${exitCode}`);
  if (outputSnippet) {
    if (lines.length > 0) lines.push("");
    lines.push(outputSnippet);
  }

  return lines.join("\n").trim() || fallback;
}

export function hasStructuredTranscriptEvents(events: HeartbeatRunEvent[]) {
  return events.some((event) => STRUCTURED_TRANSCRIPT_EVENT_TYPES.has(event.eventType));
}

export function buildTranscriptFromRunEvents(events: HeartbeatRunEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const event of events) {
    const payload = asRecord(event.payload);
    const ts = new Date(event.createdAt).toISOString();

    switch (event.eventType) {
      case "assistant.message":
        entries.push({
          kind: "assistant",
          ts,
          text: asString(payload?.text, event.message ?? ""),
          delta: payload?.delta === true,
        });
        break;
      case "assistant.thinking":
        entries.push({
          kind: "thinking",
          ts,
          text: asString(payload?.text, event.message ?? ""),
          delta: payload?.delta === true,
        });
        break;
      case "user.message":
        entries.push({
          kind: "user",
          ts,
          text: asString(payload?.text, event.message ?? ""),
        });
        break;
      case "tool.call":
        entries.push({
          kind: "tool_call",
          ts,
          name: asString(payload?.toolName, event.message ?? "tool"),
          input: payload?.input ?? {},
        });
        break;
      case "command.execution.started":
        entries.push({
          kind: "tool_call",
          ts,
          name: "command_execution",
          input: payload?.input ?? (payload ?? {}),
        });
        break;
      case "tool.result":
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: asString(payload?.toolUseId, event.message ?? "tool_result"),
          content: asString(payload?.content, event.message ?? ""),
          isError: payload?.isError === true,
        });
        break;
      case "command.execution.completed":
        entries.push({
          kind: "tool_result",
          ts,
          toolUseId: asString(payload?.toolUseId, event.message ?? "command_execution"),
          content: commandExecutionContent(payload ?? {}, event.message ?? "command execution completed"),
          isError: payload?.isError === true,
        });
        break;
      case "adapter.session.init":
        entries.push({
          kind: "init",
          ts,
          model: asString(payload?.model, "unknown"),
          sessionId: asString(payload?.sessionId),
        });
        break;
      case "adapter.result":
        entries.push({
          kind: "result",
          ts,
          text: asString(payload?.text, event.message ?? ""),
          inputTokens: asNumber(payload?.inputTokens),
          outputTokens: asNumber(payload?.outputTokens),
          cachedTokens: asNumber(payload?.cachedTokens),
          costUsd: asNumber(payload?.costUsd),
          subtype: asString(payload?.subtype),
          isError: payload?.isError === true,
          errors: Array.isArray(payload?.errors)
            ? payload!.errors.filter((value): value is string => typeof value === "string")
            : [],
        });
        break;
      case "transcript.stderr":
        entries.push({
          kind: "stderr",
          ts,
          text: asString(payload?.text, event.message ?? ""),
        });
        break;
      case "transcript.system":
        entries.push({
          kind: "system",
          ts,
          text: asString(payload?.text, event.message ?? ""),
        });
        break;
      case "transcript.stdout":
        entries.push({
          kind: "stdout",
          ts,
          text: asString(payload?.text, event.message ?? ""),
        });
        break;
      default:
        break;
    }
  }

  return entries;
}

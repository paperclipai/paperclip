import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const record = asRecord(item);
      return asString(asRecord(record?.content)?.text) || asString(record?.text);
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultText(event: Record<string, unknown>): string {
  const forPrompt = asString(asRecord(event.rawOutput)?.output_for_prompt);
  return forPrompt || contentText(event.content);
}

export function createDistillStdoutParser() {
  const toolNames = new Map<string, string>();

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: Record<string, unknown> | null = null;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      event = null;
    }
    if (!event) return [{ kind: "stdout", ts, text: line }];

    const type = asString(event.type);
    if (type === "text") {
      const text = asString(event.data);
      return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
    }
    if (type === "thought") {
      const text = asString(event.data);
      return text ? [{ kind: "thinking", ts, text, delta: true }] : [];
    }
    if (type === "tool_call") {
      const id = asString(event.toolCallId);
      const name = asString(event.toolName) || asString(event.title) || "tool";
      if (id) toolNames.set(id, name);
      return [{ kind: "tool_call", ts, name, input: event.rawInput ?? {}, toolUseId: id || undefined }];
    }
    if (type === "tool_call_update") {
      const status = asString(event.status);
      if (status !== "completed" && status !== "failed") return [];
      const id = asString(event.toolCallId);
      return [
        {
          kind: "tool_result",
          ts,
          toolUseId: id,
          toolName: toolNames.get(id),
          content: toolResultText(event),
          isError: status === "failed",
        },
      ];
    }
    if (type === "error") {
      const text =
        asString(event.message) || asString(event.data) || asString(asRecord(event.error)?.message) || "Distill error";
      return [{ kind: "stderr", ts, text }];
    }
    if (type === "end") {
      const parts: string[] = [];
      const stop = asString(event.stopReason);
      const session = asString(event.sessionId);
      if (stop) parts.push(`stop_reason=${stop}`);
      if (session) parts.push(`session=${session}`);
      const usage = asRecord(event.modelUsage);
      if (usage && Object.keys(usage).length > 0) parts.push(`models=${Object.keys(usage).join(",")}`);
      return [{ kind: "system", ts, text: parts.join(" ") || "run completed" }];
    }
    return [];
  }

  return {
    parseLine,
    reset() {
      toolNames.clear();
    },
  };
}

export function parseDistillStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return createDistillStdoutParser().parseLine(line, ts);
}

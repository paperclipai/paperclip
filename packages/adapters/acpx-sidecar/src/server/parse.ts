import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function extractTextContent(content: unknown): string {
  const record = parseObject(content);
  if (!record) return "";
  if (asString(record.type, "") !== "text") return "";
  return asString(record.text, "");
}

export function parseAcpxJson(stdout: string) {
  const assistant: string[] = [];
  const thoughts: string[] = [];
  let errorMessage: string | null = null;
  let stopReason: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const method = asString((event as Record<string, unknown>).method, "");
    if (method === "session/update") {
      const params = parseObject((event as Record<string, unknown>).params);
      const updateType = asString(params?.sessionUpdate, "");
      if (updateType === "agent_message_chunk") {
        const text = extractTextContent(params?.content);
        if (text) assistant.push(text);
        continue;
      }
      if (updateType === "agent_thought_chunk") {
        const text = extractTextContent(params?.content);
        if (text) thoughts.push(text);
        continue;
      }
      continue;
    }

    const error = parseObject((event as Record<string, unknown>).error);
    if (error) {
      const message = asString(error.message, "").trim();
      if (message) errorMessage = message;
      continue;
    }

    const result = parseObject((event as Record<string, unknown>).result);
    if (result) {
      const maybeStopReason = asString(result.stopReason, "").trim();
      if (maybeStopReason) stopReason = maybeStopReason;
      continue;
    }
  }

  return {
    summary: assistant.join("").trim(),
    thought: thoughts.join("").trim(),
    errorMessage,
    stopReason,
  };
}

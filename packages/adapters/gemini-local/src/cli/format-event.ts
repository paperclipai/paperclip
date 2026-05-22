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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function printTextMessage(prefix: string, colorize: (text: string) => string, messageRaw: unknown): void {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    if (text) console.log(colorize(`${prefix}: ${text}`));
    return;
  }

  const message = asRecord(messageRaw);
  if (!message) return;

  const directText = asString(message.text).trim();
  if (directText) console.log(colorize(`${prefix}: ${directText}`));

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();

    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text).trim() || asString(part.content).trim();
      if (text) console.log(colorize(`${prefix}: ${text}`));
      continue;
    }

    if (type === "thinking") {
      const text = asString(part.text).trim();
      if (text) console.log(pc.gray(`thinking: ${text}`));
      continue;
    }

    if (type === "tool_call") {
      const name = asString(part.name, asString(part.tool, "tool"));
      console.log(pc.yellow(`tool_call: ${name}`));
      const input = part.input ?? part.arguments ?? part.args;
      if (input !== undefined) console.log(pc.gray(stringifyUnknown(input)));
      continue;
    }

    if (type === "tool_result" || type === "tool_response") {
      const isError = part.is_error === true || asString(part.status).toLowerCase() === "error";
      const contentText =
        asString(part.output) ||
        asString(part.text) ||
        asString(part.result) ||
        stringifyUnknown(part.output ?? part.result ?? part.text ?? part.response);
      console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
      if (contentText) console.log((isError ? pc.red : pc.gray)(contentText));
    }
  }
}

function printUsage(parsed: Record<string, unknown>) {
  const usage = asRecord(parsed.usage) ?? asRecord(parsed.usageMetadata) ?? asRecord(parsed.stats);
  const usageMetadata = asRecord(usage?.usageMetadata);
  const source = usageMetadata ?? usage ?? {};
  const input = asNumber(source.input_tokens, asNumber(source.inputTokens, asNumber(source.promptTokenCount)));
  const output = asNumber(source.output_tokens, asNumber(source.outputTokens, asNumber(source.candidatesTokenCount)));
  const cached = asNumber(
    source.cached_input_tokens,
    asNumber(source.cachedInputTokens, asNumber(source.cachedContentTokenCount, asNumber(source.cached))),
  );
  const cost = asNumber(parsed.total_cost_usd, asNumber(parsed.cost_usd, asNumber(parsed.cost)));
  console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
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

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId =
        asString(parsed.session_id) ||
        asString(parsed.sessionId) ||
        asString(parsed.sessionID) ||
        asString(parsed.checkpoint_id);
      const model = asString(parsed.model);
      const details = [sessionId ? `session: ${sessionId}` : "", model ? `model: ${model}` : ""]
        .filter(Boolean)
        .join(", ");
      console.log(pc.blue(`Gemini init${details ? ` (${details})` : ""}`));
      return;
    }
    if (subtype === "error") {
      const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
      if (text) console.log(pc.red(`error: ${text}`));
      return;
    }
    console.log(pc.blue(`system: ${subtype || "event"}`));
    return;
  }

  if (type === "assistant") {
    printTextMessage("assistant", pc.green, parsed.message);
    return;
  }

  if (type === "user") {
    printTextMessage("user", pc.gray, parsed.message);
    return;
  }

  // Gemini CLI v0.38+ stream-json schema:
  // {"type":"message","role":"assistant"|"user","content":"...","delta":?true}
  if (type === "message") {
    const role = asString(parsed.role).trim().toLowerCase();
    if (role === "assistant") {
      printTextMessage("assistant", pc.green, parsed.content);
      return;
    }
    if (role === "user") {
      printTextMessage("user", pc.gray, parsed.content);
      return;
    }
    return;
  }

  if (type === "thinking") {
    const text = asString(parsed.text).trim() || asString(asRecord(parsed.delta)?.text).trim();
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "tool_call") {
    const subtype = asString(parsed.subtype).trim().toLowerCase();
    const toolCall = asRecord(parsed.tool_call ?? parsed.toolCall);
    const [toolName] = toolCall ? Object.keys(toolCall) : [];
    if (!toolCall || !toolName) {
      console.log(pc.yellow(`tool_call${subtype ? `: ${subtype}` : ""}`));
      return;
    }
    const payload = asRecord(toolCall[toolName]) ?? {};
    if (subtype === "started" || subtype === "start") {
      console.log(pc.yellow(`tool_call: ${toolName}`));
      console.log(pc.gray(stringifyUnknown(payload.args ?? payload.input ?? payload.arguments ?? payload)));
      return;
    }
    if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
      const isError =
        parsed.is_error === true ||
        payload.is_error === true ||
        payload.error !== undefined ||
        asString(payload.status).toLowerCase() === "error";
      console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
      console.log((isError ? pc.red : pc.gray)(stringifyUnknown(payload.result ?? payload.output ?? payload.error)));
      return;
    }
    console.log(pc.yellow(`tool_call: ${toolName}${subtype ? ` (${subtype})` : ""}`));
    return;
  }

  if (type === "result") {
    printUsage(parsed);
    const status = asString(parsed.status).toLowerCase();
    const isError =
      parsed.is_error === true || status === "error" || status === "failed";
    const subtype = asString(parsed.subtype, status || "result");
    if (subtype || isError) {
      console.log((isError ? pc.red : pc.blue)(`result: subtype=${subtype} is_error=${isError ? "true" : "false"}`));
    }
    if (isError) {
      const text = errorText(parsed.error ?? parsed.message ?? parsed.result);
      if (text) console.log(pc.red(`error: ${text}`));
    }
    return;
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    if (text) console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(line);
}

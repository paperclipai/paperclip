import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

// Kimi CLI auth error patterns
const KIMI_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|login\s+required|unauthorized|authentication\s+required)/i;

// Kimi stream JSON format:
// {"role":"assistant","content":[{"type":"think","think":"..."},{"type":"text","text":"..."}]}
// {"role":"assistant","content":[{"type":"tool_use","name":"...","input":{}}]}

export interface KimiStreamResult {
  sessionId: string | null;
  model: string | null;
  costUsd: number | null;
  usage: UsageSummary | null;
  summary: string;
  resultJson: Record<string, unknown> | null;
}

export function parseKimiStreamJson(stdout: string): KimiStreamResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  const assistantTexts: string[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  let finalResult: Record<string, unknown> | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const role = asString(event.role, "");
    
    if (role === "assistant") {
      const content = Array.isArray(event.content) ? event.content : [];
      for (const block of content) {
        if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
        const blockType = asString((block as Record<string, unknown>).type, "");
        
        if (blockType === "text") {
          const text = asString((block as Record<string, unknown>).text, "");
          if (text) assistantTexts.push(text);
        } else if (blockType === "think") {
          // Thinking content - could be logged separately if needed
          const think = asString((block as Record<string, unknown>).think, "");
          if (think) assistantTexts.push(`[Thinking] ${think}`);
        } else if (blockType === "tool_use") {
          const name = asString((block as Record<string, unknown>).name, "");
          const input = (block as Record<string, unknown>).input ?? {};
          if (name) toolCalls.push({ name, input });
        }
      }
      continue;
    }

    // Check for result/error objects at end of stream
    if (event.type === "result" || event.type === "error" || event.done === true) {
      finalResult = event;
      if (event.model) model = asString(event.model, model ?? "");
      if (event.session_id) sessionId = asString(event.session_id, sessionId ?? "");
    }
  }

  // Build summary from collected texts and tool calls
  const summaryParts: string[] = [];
  if (assistantTexts.length > 0) {
    summaryParts.push(assistantTexts.join("\n\n"));
  }
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      summaryParts.push(`[Tool: ${tc.name}] ${JSON.stringify(tc.input)}`);
    }
  }

  // Try to extract usage from final result
  let usage: UsageSummary | null = null;
  if (finalResult?.usage) {
    const u = parseObject(finalResult.usage);
    usage = {
      inputTokens: asNumber(u.input_tokens, 0),
      outputTokens: asNumber(u.output_tokens, 0),
      cachedInputTokens: asNumber(u.cache_read_input_tokens, 0),
    };
  }

  const costUsd = typeof finalResult?.total_cost_usd === "number" 
    ? finalResult.total_cost_usd 
    : null;

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary: summaryParts.join("\n\n").trim(),
    resultJson: finalResult,
  };
}

function extractKimiErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];

  // Check for explicit error field
  if (typeof parsed.error === "string") {
    messages.push(parsed.error);
  }

  // Check for errors array
  if (Array.isArray(parsed.errors)) {
    for (const entry of parsed.errors) {
      if (typeof entry === "string") {
        messages.push(entry);
      } else if (typeof entry === "object" && entry !== null) {
        const msg = asString((entry as Record<string, unknown>).message, "")
          || asString((entry as Record<string, unknown>).error, "")
          || asString((entry as Record<string, unknown>).code, "");
        if (msg) messages.push(msg);
      }
    }
  }

  // Check result text for error indicators
  const resultText = asString(parsed.result, "").trim();
  if (resultText && resultText.toLowerCase().includes("error")) {
    messages.push(resultText);
  }

  return messages.filter(Boolean);
}

export function detectKimiLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const allText = [input.stdout, input.stderr].join("\n").toLowerCase();
  
  // Check for auth error patterns
  const requiresLogin = KIMI_AUTH_REQUIRED_RE.test(allText);
  
  // Kimi doesn't provide a login URL in output; user needs to run `kimi login`
  return {
    requiresLogin,
    loginUrl: null,
  };
}

export function describeKimiFailure(parsed: Record<string, unknown>): string | null {
  const errors = extractKimiErrorMessages(parsed);
  const resultText = asString(parsed.result, "").trim();
  const type = asString(parsed.type, "");

  if (errors.length > 0) {
    return `Kimi error: ${errors[0]}`;
  }

  if (resultText) {
    return `Kimi run failed: ${resultText}`;
  }

  if (type === "error") {
    return "Kimi run failed with unknown error";
  }

  return null;
}

export function isKimiUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractKimiErrorMessages(parsed)]
    .map((m) => m.toLowerCase())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /session\s+not\s+found|unknown\s+session|invalid\s+session|会话.*不存在/.test(msg),
  );
}

export function isKimiMaxStepsError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim().toLowerCase();
  const errors = extractKimiErrorMessages(parsed).map((e) => e.toLowerCase());
  
  return (
    resultText.includes("max steps") ||
    resultText.includes("maximum steps") ||
    errors.some((e) => e.includes("max steps") || e.includes("maximum steps"))
  );
}

/**
 * JSON stream parser for Bob Shell output
 * 
 * This parser is designed to handle future JSON event stream format from Bob Shell CLI.
 * Currently, Bob Shell outputs XML format, but this parser prepares for a future
 * JSON-based streaming protocol.
 * 
 * Expected JSON stream format:
 * ```
 * {"type":"system","subtype":"session_init","session_id":"abc123","model":"claude-3-5-sonnet-20241022"}
 * {"type":"assistant","text":"Let me help you with that..."}
 * {"type":"thinking","text":"I need to analyze the requirements..."}
 * {"type":"tool_use","name":"read_file","input":{"file_path":"/path/to/file"}}
 * {"type":"tool_result","content":"file contents","is_error":false}
 * {"type":"usage","input_tokens":1000,"cached_input_tokens":500,"output_tokens":200}
 * {"type":"cost","cost_usd":0.05}
 * {"type":"result","result":"Task completed successfully"}
 * ```
 */

import { BobStreamResult } from "./parse-stdout.js";

interface JsonEvent {
  type: string;
  [key: string]: unknown;
}

interface SystemEvent extends JsonEvent {
  type: "system";
  subtype?: string;
  session_id?: string;
  model?: string;
}

interface AssistantEvent extends JsonEvent {
  type: "assistant";
  text: string;
}

interface ThinkingEvent extends JsonEvent {
  type: "thinking";
  text: string;
}

interface ToolUseEvent extends JsonEvent {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface ToolResultEvent extends JsonEvent {
  type: "tool_result";
  content: string;
  is_error: boolean;
}

interface UsageEvent extends JsonEvent {
  type: "usage";
  input_tokens: number;
  cached_input_tokens?: number;
  output_tokens: number;
}

interface CostEvent extends JsonEvent {
  type: "cost";
  cost_usd: number;
}

interface ResultEvent extends JsonEvent {
  type: "result";
  result: string;
}

interface ErrorEvent extends JsonEvent {
  type: "error";
  error_code?: string;
  error_message?: string;
  is_retryable?: boolean;
}

/**
 * Parse a single JSON event line
 */
function parseJsonEvent(line: string): JsonEvent | null {
  try {
    const event = JSON.parse(line);
    if (typeof event === "object" && event !== null && "type" in event) {
      return event as JsonEvent;
    }
  } catch {
    // Not valid JSON, skip
  }
  return null;
}

const BOB_JSON_EVENT_TYPES = new Set([
  "system", "assistant", "thinking", "tool_use", "tool_result",
  "usage", "cost", "result", "error",
]);

/**
 * Check if stdout contains JSON stream format
 * Returns true if at least one valid JSON event with a known bob event type is found
 */
export function isJsonStream(stdout: string): boolean {
  const lines = stdout.split("\n").filter(line => line.trim());

  for (const line of lines) {
    const event = parseJsonEvent(line);
    if (event && BOB_JSON_EVENT_TYPES.has(event.type)) {
      return true;
    }
  }

  return false;
}

/**
 * Parse Bob Shell JSON stream output
 * 
 * This function processes a JSON event stream and extracts:
 * - Session ID and model information
 * - Assistant messages and thinking blocks
 * - Token usage and cost data
 * - Final result
 * 
 * @param stdout - Raw stdout from Bob Shell containing JSON events
 * @returns Parsed result with metadata and messages
 */
export function parseJsonStream(stdout: string): BobStreamResult | null {
  const lines = stdout.split("\n").filter(line => line.trim());
  
  // Accumulated state
  let sessionId: string | null = null;
  let model: string | null = null;
  let usage: BobStreamResult["usage"] = null;
  let costUsd: number | null = null;
  const assistantTexts: string[] = [];
  const thinkingTexts: string[] = [];
  let finalResult: string | null = null;
  
  // Track if we found any valid JSON events
  let foundJsonEvent = false;
  
  for (const line of lines) {
    const event = parseJsonEvent(line);
    if (!event || !BOB_JSON_EVENT_TYPES.has(event.type)) continue;

    foundJsonEvent = true;

    switch (event.type) {
      case "system": {
        const systemEvent = event as SystemEvent;
        if (systemEvent.subtype === "session_init") {
          sessionId = systemEvent.session_id ?? null;
          model = systemEvent.model ?? null;
        }
        break;
      }
      
      case "assistant": {
        const assistantEvent = event as AssistantEvent;
        if (assistantEvent.text) {
          assistantTexts.push(assistantEvent.text);
        }
        break;
      }
      
      case "thinking": {
        const thinkingEvent = event as ThinkingEvent;
        if (thinkingEvent.text) {
          thinkingTexts.push(thinkingEvent.text);
        }
        break;
      }
      
      case "usage": {
        const usageEvent = event as UsageEvent;
        usage = {
          inputTokens: usageEvent.input_tokens || 0,
          cachedInputTokens: usageEvent.cached_input_tokens || 0,
          outputTokens: usageEvent.output_tokens || 0,
        };
        break;
      }
      
      case "cost": {
        const costEvent = event as CostEvent;
        costUsd = costEvent.cost_usd;
        break;
      }
      
      case "result": {
        const resultEvent = event as ResultEvent;
        finalResult = resultEvent.result;
        break;
      }
      
      case "error": {
        const errorEvent = event as ErrorEvent;
        // Store error information for future use
        // For now, we don't have a place to put it in BobStreamResult
        // This will be added when we enhance the result type
        break;
      }
      
      // Ignore tool_use and tool_result events for now
      // They don't contribute to the summary
    }
  }
  
  // If we didn't find any JSON events, return null to trigger fallback
  if (!foundJsonEvent) {
    return null;
  }
  
  // Generate summary (aligned with XML parser — no truncation)
  let summary = "";

  if (finalResult) {
    summary = finalResult;
  } else if (assistantTexts.length > 0) {
    summary = assistantTexts.slice(-3).join("\n\n");
  } else if (thinkingTexts.length > 0) {
    summary = thinkingTexts[thinkingTexts.length - 1] || "";
  } else {
    summary = "";
  }
  
  return {
    summary: summary.trim(),
    finalResult,
    assistantTexts,
    thinkingTexts,
    sessionId,
    model,
    usage,
    costUsd,
    resultJson: null,
  };
}

/**
 * Parse Bob Shell output with JSON-first fallback
 * 
 * This function tries to parse as JSON stream first, then falls back to XML
 * if JSON parsing fails or returns null.
 * 
 * @param stdout - Raw stdout from Bob Shell
 * @param xmlParser - Fallback XML parser function
 * @returns Parsed result
 */
export function parseWithFallback(
  stdout: string,
  xmlParser: (stdout: string) => BobStreamResult
): BobStreamResult {
  // Try JSON stream first
  const jsonResult = parseJsonStream(stdout);
  if (jsonResult) {
    return jsonResult;
  }
  
  // Fall back to XML parser
  return xmlParser(stdout);
}

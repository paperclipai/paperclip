import { parseJson } from "@paperclipai/adapter-utils/server-utils";
import { extractBobMetadata, calculateCostFromUsage } from "./metadata-extraction.js";
import { parseWithFallback as parseJsonWithFallback } from "./parse-json-stream.js";

interface ParsedBobOutput {
  assistantMessages: string[];
  thinkingMessages: string[];
  toolCalls: Array<{ name: string; input: unknown }>;
  toolResults: Array<{ content: string; isError: boolean }>;
  finalResult: string | null;
}

export interface BobStreamResult {
  summary: string;
  finalResult: string | null;
  assistantTexts: string[];
  thinkingTexts: string[];
  sessionId?: string | null;
  model?: string | null;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  } | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
}

/**
 * Streaming parser for Bob Shell output - processes stdout incrementally
 * Returns accumulated state that can be used to generate progressive summaries
 * 
 * This function uses a JSON-first approach with XML fallback:
 * 1. Try to parse as JSON stream (future format)
 * 2. Fall back to XML parsing (current format)
 */
export function parseBobShellStream(stdout: string): BobStreamResult {
  // Try JSON-first with XML fallback
  return parseJsonWithFallback(stdout, parseBobShellStreamXml);
}

/**
 * XML-based streaming parser for Bob Shell output
 * This is the current format parser, used as fallback when JSON parsing fails
 */
function parseBobShellStreamXml(stdout: string): BobStreamResult {
  const assistantTexts: string[] = [];
  const thinkingTexts: string[] = [];
  let finalResult: string | null = null;

  // Extract attempt_completion result FIRST (highest priority for summary)
  const attemptCompletionMatch = stdout.match(
    /<attempt_completion>[\s\S]*?<result>([\s\S]*?)<\/result>[\s\S]*?<\/attempt_completion>/
  );
  if (attemptCompletionMatch && attemptCompletionMatch[1]) {
    finalResult = attemptCompletionMatch[1].trim();
  }

  // Fallback: legacy ---output--- block emitted by older bob-shell builds
  // Format: [using tool attempt_completion: ...]\n---output---\n<content>\n---output---
  if (!finalResult) {
    const outputBlockMatch = stdout.match(
      /\[using tool attempt_completion:[^\]]*\]\s*\n---output---\n([\s\S]*?)\n---output---/
    );
    if (outputBlockMatch && outputBlockMatch[1]) {
      finalResult = outputBlockMatch[1].trim();
    }
  }

  // Start with original text for cleaning
  let cleanedText = stdout;
  
  // Extract thinking blocks before removing them
  const thinkingMatches = stdout.matchAll(/<thinking>([\s\S]*?)<\/thinking>/g);
  for (const match of thinkingMatches) {
    if (match[1]) {
      const thinking = match[1].trim();
      if (thinking) thinkingTexts.push(thinking);
    }
  }
  
  // Remove thinking blocks (including incomplete ones)
  cleanedText = cleanedText.replace(/<thinking>[\s\S]*?<\/thinking>/g, "\n");
  cleanedText = cleanedText.replace(/<thinking>[\s\S]*$/g, "\n"); // Incomplete thinking blocks
  cleanedText = cleanedText.replace(/<\/thinking>/g, ""); // Stray closing tags
  
  // Remove attempt_completion blocks (already extracted the result)
  cleanedText = cleanedText.replace(/<attempt_completion>[\s\S]*?<\/attempt_completion>/g, "\n");

  // Remove all other XML tool calls (any tags that look like tools)
  cleanedText = cleanedText.replace(/<(\w+)>[\s\S]*?<\/\1>/g, "\n");
  cleanedText = cleanedText.replace(/<\/\w+>/g, ""); // Stray closing tags
  
  // Remove tool status lines
  cleanedText = cleanedText.replace(/Tool <\w+> status: (Success|Error)[\s\S]*?(?=\n|$)/g, "");
  
  // Remove tool usage indicators (may span multiple lines with command details)
  cleanedText = cleanedText.replace(/\[using tool [\s\S]*?\]/g, "");
  
  // Remove output markers
  cleanedText = cleanedText.replace(/---output---/g, "");
  
  // Remove system messages ([system] and [paperclip] internal lines)
  cleanedText = cleanedText.replace(/\[system\][^\n]*/g, "");
  cleanedText = cleanedText.replace(/\[paperclip\][^\n]*/g, "");

  // Remove tool response wrappers
  cleanedText = cleanedText.replace(/tool response is wrapped in '(response|error_message)' xml tag:/g, "");

  // Remove restore ID lines
  cleanedText = cleanedText.replace(/restore ID before tool use:[^\n]*/g, "");

  // Extract assistant messages from cleaned text
  const lines = cleanedText.split("\n");
  let currentMessage = "";
  let inJsonBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      if (currentMessage) {
        assistantTexts.push(currentMessage.trim());
        currentMessage = "";
      }
      inJsonBlock = false;
      continue;
    }

    // Track JSON blocks from tool responses
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      inJsonBlock = true;
    }
    if (trimmed === "}" || trimmed === "]" || trimmed === "}," || trimmed === "],") {
      inJsonBlock = false;
      continue;
    }
    if (inJsonBlock) continue;

    // Skip lines that look like metadata or artifacts
    if (trimmed.startsWith("Designer") ||
        trimmed.startsWith("Wake acknowledgement") ||
        trimmed.startsWith("Issue") ||
        trimmed.match(/^[A-Z]+-\d+$/) || // Issue IDs like DSI-178
        trimmed.includes("is already assigned") ||
        trimmed.includes("no new comment batch") ||
        trimmed.startsWith("-H ") || // curl header args
        trimmed.startsWith("-d ") || // curl data args
        trimmed.startsWith("--") || // multi-line command continuation
        trimmed.match(/^\(\d+s\)\]?$/) || // bare timing fragments like "(30s)]"
        trimmed.match(/\(\d+s\)\]?$/) // bob status lines like "(Get my identity) (30s)]"
        ) {
      continue;
    }
    
    currentMessage += (currentMessage ? "\n" : "") + trimmed;
  }

  // Add final message if any
  if (currentMessage) {
    assistantTexts.push(currentMessage.trim());
  }

  // Generate progressive summary
  let summary = "";
  
  if (finalResult) {
    // Clean up final result
    let result = finalResult
      .replace(/---output---/g, "")
      .replace(/^[\s\n]+|[\s\n]+$/g, "")
      .replace(/\n{3,}/g, "\n\n");

    const lines = result.split("\n");
    const cleanedLines = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("/") && !trimmed.includes(" ")) return false;
      if (trimmed.match(/\b(located|saved|written|created|stored|found|ready)\s+(at|in|to|and\s+located\s+at):\s*\//i)) return false;
      return true;
    });

    result = cleanedLines.join("\n").trim();
    // Use finalResult without truncation - it's the most important output for comments
    summary = result;
  }

  if (!summary && assistantTexts.length > 0) {
    const lastMessages = assistantTexts.slice(-3).join("\n\n");
    // Don't truncate assistant messages - they're used for task comments
    summary = lastMessages;
  }

  // NOTE: Do NOT use thinkingTexts for summary - thinking is internal reasoning
  // and should never be exposed in user-facing comments. Only use finalResult
  // and assistantTexts which are intended for external communication.

  if (!summary) {
    summary = assistantTexts.length > 0 
      ? "Working..." 
      : "";
  }

  // Extract metadata from stdout
  const metadata = extractBobMetadata(stdout);
  
  // Calculate cost from usage if not provided
  let finalCost = metadata.costUsd;
  if (!finalCost && metadata.usage && metadata.model) {
    finalCost = calculateCostFromUsage(metadata.usage, metadata.model);
  }

  return {
    summary: summary.trim(),
    finalResult,
    assistantTexts,
    thinkingTexts,
    sessionId: metadata.sessionId,
    model: metadata.model,
    usage: metadata.usage,
    costUsd: finalCost,
    resultJson: null,
  };
}

/**
 * Parse Bob Shell stdout to extract structured information
 * Bob Shell outputs a mix of:
 * - Assistant text responses
 * - <thinking> tags
 * - Tool calls in XML format
 * - Tool results
 * - <attempt_completion> with final result
 */
export function parseBobShellOutput(stdout: string): ParsedBobOutput {
  const result: ParsedBobOutput = {
    assistantMessages: [],
    thinkingMessages: [],
    toolCalls: [],
    toolResults: [],
    finalResult: null,
  };

  // Extract attempt_completion result (highest priority for summary)
  const attemptCompletionMatch = stdout.match(
    /<attempt_completion>\s*<result>([\s\S]*?)<\/result>\s*<\/attempt_completion>/
  );
  if (attemptCompletionMatch && attemptCompletionMatch[1]) {
    result.finalResult = attemptCompletionMatch[1].trim();
  }

  // Extract thinking blocks
  const thinkingMatches = stdout.matchAll(/<thinking>([\s\S]*?)<\/thinking>/g);
  for (const match of thinkingMatches) {
    if (match[1]) {
      const thinking = match[1].trim();
      if (thinking) result.thinkingMessages.push(thinking);
    }
  }

  // Extract tool calls (various tool formats)
  const toolCallMatches = stdout.matchAll(/<(\w+)>\s*([\s\S]*?)<\/\1>/g);
  for (const match of toolCallMatches) {
    const toolName = match[1];
    // Skip known non-tool tags
    if (["thinking", "attempt_completion", "result", "response", "error_message"].includes(toolName)) {
      continue;
    }
    result.toolCalls.push({
      name: toolName,
      input: match[2]?.trim() || "",
    });
  }

  // Extract tool results (look for "Tool <name> status:" patterns)
  const toolResultMatches = stdout.matchAll(
    /Tool <(\w+)> status: (Success|Error)\s*(?:tool response[^\n]*\n<response>([\s\S]*?)<\/response>)?/g
  );
  for (const match of toolResultMatches) {
    const isError = match[2] === "Error";
    const content = match[3]?.trim() || "";
    if (content) {
      result.toolResults.push({ content, isError });
    }
  }

  // Extract assistant messages (text between tool calls and system messages)
  const lines = stdout.split("\n");
  let currentMessage = "";
  let inToolCall = false;
  let inSystemMessage = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Detect system messages
    if (trimmed.startsWith("[system]")) {
      if (currentMessage) {
        result.assistantMessages.push(currentMessage.trim());
        currentMessage = "";
      }
      inSystemMessage = true;
      continue;
    }

    // Detect tool calls
    if (trimmed.startsWith("<") && !trimmed.startsWith("</")) {
      if (currentMessage) {
        result.assistantMessages.push(currentMessage.trim());
        currentMessage = "";
      }
      inToolCall = true;
      continue;
    }

    // Detect end of tool call
    if (trimmed.startsWith("</")) {
      inToolCall = false;
      continue;
    }

    // Detect tool status lines
    if (trimmed.startsWith("Tool <")) {
      inSystemMessage = false;
      continue;
    }

    // Skip if in tool call or system message
    if (inToolCall || inSystemMessage) continue;

    // Skip tool response wrappers
    if (trimmed === "tool response is wrapped in 'response' xml tag:" || 
        trimmed === "tool response is wrapped in 'error_message' xml tag:") {
      continue;
    }

    // Skip restore ID lines
    if (trimmed.includes("restore ID before tool use:")) continue;

    // Accumulate assistant message
    if (trimmed) {
      currentMessage += (currentMessage ? "\n" : "") + trimmed;
    }
  }

  // Add final message if any
  if (currentMessage) {
    result.assistantMessages.push(currentMessage.trim());
  }

  return result;
}

/**
 * Generate a clean summary from parsed Bob Shell output
 */
export function generateBobShellSummary(parsed: ParsedBobOutput): string {
  // Priority 1: Use final result from attempt_completion
  if (parsed.finalResult) {
    let result = parsed.finalResult;

    // Clean up common artifacts
    result = result
      .replace(/---output---/g, "")
      .replace(/^[\s\n]+|[\s\n]+$/g, "")
      .replace(/\n{3,}/g, "\n\n");

    // Remove standalone file paths and location references
    const lines = result.split("\n");
    const cleanedLines = lines.filter((line) => {
      const trimmed = line.trim();
      // Skip lines that are just file paths
      if (trimmed.startsWith("/") && !trimmed.includes(" ")) return false;
      // Skip lines with "located at:" or similar patterns followed by a path
      if (trimmed.match(/\b(located|saved|written|created|stored|found|ready)\s+(at|in|to|and\s+located\s+at):\s*\//i)) return false;
      return true;
    });

    result = cleanedLines.join("\n").trim();

    // If we have meaningful content, use it without truncation
    if (result.length > 50) {
      return result;
    }
  }

  // Priority 2: Use last few assistant messages without truncation
  if (parsed.assistantMessages.length > 0) {
    const lastMessages = parsed.assistantMessages.slice(-3).join("\n\n");
    return lastMessages;
  }

  // Priority 3: Use thinking if available without truncation
  if (parsed.thinkingMessages.length > 0) {
    const lastThinking = parsed.thinkingMessages[parsed.thinkingMessages.length - 1];
    return lastThinking;
  }

  // Fallback
  return "Bob Shell completed successfully";
}

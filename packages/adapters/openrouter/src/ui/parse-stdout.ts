// ─────────────────────────────────────────────────────────────────
// @paperclipai/adapter-openrouter — UI Parse Stdout
// Converts raw stdout into transcript entries for the run viewer
// ─────────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  type: "text" | "thinking" | "tool_call" | "tool_result" | "error" | "info";
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Parse stdout lines from an OpenRouter adapter run into
 * transcript entries for Paperclip's run viewer UI.
 */
export function parseStdout(stdout: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const lines = stdout.split("\n");

  let currentBlock = "";
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code blocks to avoid splitting them
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
    }

    // SSE stream data lines
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        if (currentBlock.trim()) {
          entries.push({ type: "text", content: currentBlock.trim() });
          currentBlock = "";
        }
        continue;
      }

      try {
        const parsed = JSON.parse(data);

        // Reasoning / thinking content
        const reasoning =
          parsed.choices?.[0]?.delta?.reasoning_content ||
          parsed.choices?.[0]?.delta?.reasoning;
        if (reasoning) {
          entries.push({
            type: "thinking",
            content: reasoning,
            metadata: { model: parsed.model },
          });
          continue;
        }

        // Regular content
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          currentBlock += content;
        }

        // Tool calls
        const toolCalls = parsed.choices?.[0]?.delta?.tool_calls;
        if (toolCalls?.length) {
          for (const tc of toolCalls) {
            entries.push({
              type: "tool_call",
              content: `${tc.function?.name || "tool"}(${tc.function?.arguments || ""})`,
              metadata: { toolCallId: tc.id },
            });
          }
        }
      } catch {
        // Not JSON — treat as raw text
        if (data) currentBlock += data;
      }
      continue;
    }

    // Error lines
    if (
      line.includes("OpenRouter API error") ||
      line.includes("Error:") ||
      line.includes("error")
    ) {
      entries.push({ type: "error", content: line });
      continue;
    }

    // Info lines (model selection, cost)
    if (
      line.includes("[openrouter]") ||
      line.includes("model:") ||
      line.includes("tokens:") ||
      line.includes("cost:")
    ) {
      entries.push({ type: "info", content: line });
      continue;
    }

    // Regular output
    currentBlock += line + "\n";
  }

  // Flush remaining
  if (currentBlock.trim()) {
    entries.push({ type: "text", content: currentBlock.trim() });
  }

  return entries;
}

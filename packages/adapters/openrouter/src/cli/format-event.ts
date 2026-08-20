// ─────────────────────────────────────────────────────────────────
// @paperclipai/adapter-openrouter — CLI Format Event
// Pretty-prints stdout for `paperclipai run --watch` in terminal
// ─────────────────────────────────────────────────────────────────

// NOTE: picocolors is a peer dep — import dynamically to avoid
// breaking server/ui bundles that don't need it.

interface FormatOptions {
  verbose?: boolean;
}

/**
 * Format a single stdout line for terminal display.
 * Called by Paperclip CLI's --watch mode.
 */
export function formatEvent(
  line: string,
  _opts?: FormatOptions
): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // SSE data lines — extract content
  if (trimmed.startsWith("data: ")) {
    const data = trimmed.slice(6);
    if (data === "[DONE]") return null;

    try {
      const parsed = JSON.parse(data);

      // Reasoning
      const reasoning =
        parsed.choices?.[0]?.delta?.reasoning_content ||
        parsed.choices?.[0]?.delta?.reasoning;
      if (reasoning) {
        return `💭 ${reasoning}`;
      }

      // Content
      const content = parsed.choices?.[0]?.delta?.content;
      if (content) return content;

      // Usage summary at end
      if (parsed.usage) {
        const u = parsed.usage;
        return `\n📊 ${u.prompt_tokens || 0} in / ${u.completion_tokens || 0} out tokens`;
      }

      return null;
    } catch {
      return data;
    }
  }

  // Error lines
  if (
    trimmed.includes("error") ||
    trimmed.includes("Error") ||
    trimmed.includes("OPENROUTER")
  ) {
    return `❌ ${trimmed}`;
  }

  // Info lines
  if (trimmed.startsWith("[openrouter]")) {
    return `🔀 ${trimmed}`;
  }

  // Default: pass through
  return trimmed;
}

/**
 * Format a run summary for terminal display.
 */
export function formatRunSummary(result: {
  success: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  metadata?: Record<string, unknown>;
}): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push("✅ OpenRouter run completed");
  } else {
    lines.push("❌ OpenRouter run failed");
  }

  if (result.metadata?.model) {
    lines.push(`   Model: ${result.metadata.model}`);
  }

  if (result.usage) {
    lines.push(
      `   Tokens: ${result.usage.inputTokens.toLocaleString()} in / ${result.usage.outputTokens.toLocaleString()} out`
    );
    if (result.usage.costUsd > 0) {
      lines.push(`   Cost: $${result.usage.costUsd.toFixed(6)}`);
    } else {
      lines.push("   Cost: $0.00 (free model)");
    }
  }

  return lines.join("\n");
}

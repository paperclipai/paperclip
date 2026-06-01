import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

/**
 * Usage summary for token tracking
 */
export interface UsageSummary {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Metadata extracted from Bob Shell output
 */
export interface BobMetadata {
  sessionId: string | null;
  model: string | null;
  usage: UsageSummary | null;
  costUsd: number | null;
}

/**
 * Extract session ID from Bob Shell output
 * Looks for patterns like:
 * - "Session ID: abc123"
 * - "session_id: abc123"
 * - "Saved session: abc123"
 */
export function extractSessionId(stdout: string): string | null {
  const patterns = [
    /session\s+id:\s*([a-zA-Z0-9_-]+)/i,
    /saved\s+session:\s*([a-zA-Z0-9_-]+)/i,
    /session:\s*([a-zA-Z0-9_-]+)/i,
    /resuming\s+session:\s*([a-zA-Z0-9_-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = stdout.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract model information from Bob Shell output
 * Looks for patterns like:
 * - "Model: claude-3-5-sonnet-20241022"
 * - "Using model: gpt-4"
 * - "model_id: claude-opus"
 */
export function extractModel(stdout: string): string | null {
  const patterns = [
    /model:\s*([a-zA-Z0-9._-]+)/i,
    /using\s+model:\s*([a-zA-Z0-9._-]+)/i,
    /model_id:\s*([a-zA-Z0-9._-]+)/i,
    /model_name:\s*([a-zA-Z0-9._-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = stdout.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract token usage from Bob Shell output
 * Looks for JSON blocks or structured output like:
 * - {"usage": {"input_tokens": 100, "output_tokens": 50}}
 * - Input tokens: 100, Output tokens: 50
 * - Tokens used: 150 (100 input, 50 output)
 */
export function extractUsage(stdout: string): UsageSummary | null {
  // Try to find JSON usage block first (more flexible regex)
  const jsonMatch = stdout.match(/\{[^}]*"usage"[^}]*"input_tokens"[^}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const usageObj = parseObject(parsed.usage);
      if (usageObj) {
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0) || 
                            asNumber(usageObj.cached_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      }
    } catch {
      // Fall through to pattern matching
    }
  }

  // Try pattern matching for structured output
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  // Input tokens patterns
  const inputMatch = stdout.match(/input\s+tokens?:\s*(\d+)/i);
  if (inputMatch) {
    inputTokens = parseInt(inputMatch[1], 10);
  }

  // Cached input tokens patterns
  const cachedMatch = stdout.match(/cached?\s+(?:input\s+)?tokens?:\s*(\d+)/i);
  if (cachedMatch) {
    cachedInputTokens = parseInt(cachedMatch[1], 10);
  }

  // Output tokens patterns
  const outputMatch = stdout.match(/output\s+tokens?:\s*(\d+)/i);
  if (outputMatch) {
    outputTokens = parseInt(outputMatch[1], 10);
  }

  // Alternative pattern: "Tokens: 150 (100 input, 50 output)"
  const combinedMatch = stdout.match(/tokens?:\s*\d+\s*\((\d+)\s+input,\s*(\d+)\s+output\)/i);
  if (combinedMatch) {
    inputTokens = parseInt(combinedMatch[1], 10);
    outputTokens = parseInt(combinedMatch[2], 10);
  }

  // Only return usage if we found at least input or output tokens
  if (inputTokens > 0 || outputTokens > 0) {
    return {
      inputTokens,
      cachedInputTokens,
      outputTokens,
    };
  }

  return null;
}

/**
 * Extract cost from Bob Shell output
 * Looks for patterns like:
 * - "Cost: $0.05"
 * - "Total cost: 0.05 USD"
 * - "cost_usd: 0.05"
 */
export function extractCost(stdout: string): number | null {
  const patterns = [
    /cost:\s*\$?([\d.]+)/i,
    /total\s+cost:\s*\$?([\d.]+)/i,
    /cost_usd:\s*([\d.]+)/i,
    /\$\s*([\d.]+)\s+(?:usd|cost)/i,
  ];

  for (const pattern of patterns) {
    const match = stdout.match(pattern);
    if (match && match[1]) {
      const cost = parseFloat(match[1]);
      if (Number.isFinite(cost) && cost >= 0) {
        return cost;
      }
    }
  }

  return null;
}

/**
 * Extract all metadata from Bob Shell output
 */
export function extractBobMetadata(stdout: string): BobMetadata {
  return {
    sessionId: extractSessionId(stdout),
    model: extractModel(stdout),
    usage: extractUsage(stdout),
    costUsd: extractCost(stdout),
  };
}

/**
 * Calculate cost from usage if not provided
 * Uses approximate pricing for common models
 */
export function calculateCostFromUsage(
  usage: UsageSummary,
  model: string | null
): number | null {
  if (!model) return null;

  // Approximate pricing per 1M tokens (as of 2024)
  const pricing: Record<string, { input: number; output: number }> = {
    // Claude models
    "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
    "claude-3-opus": { input: 15.0, output: 75.0 },
    "claude-3-sonnet": { input: 3.0, output: 15.0 },
    "claude-3-haiku": { input: 0.25, output: 1.25 },
    
    // GPT models
    "gpt-4": { input: 30.0, output: 60.0 },
    "gpt-4-turbo": { input: 10.0, output: 30.0 },
    "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  };

  // Find matching pricing
  let modelPricing = null;
  for (const [key, value] of Object.entries(pricing)) {
    if (model.toLowerCase().includes(key.toLowerCase())) {
      modelPricing = value;
      break;
    }
  }

  if (!modelPricing) return null;

  // Calculate cost
  const inputCost = (usage.inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * modelPricing.output;
  
  // Cached tokens are typically cheaper (90% discount)
  const cachedCost = (usage.cachedInputTokens / 1_000_000) * modelPricing.input * 0.1;

  return inputCost + outputCost + cachedCost;
}

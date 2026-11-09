// EYW-797 — compact-on-resume helpers for OpenCode sessions.
//
// A resumed OpenCode session re-sends its full transcript on every provider
// turn. When that transcript would push the next turn past the model's
// context window, the adapter starts a fresh session seeded with a bounded
// digest of the old one instead of passing --session. The helpers here are
// pure and unit-testable; the only opencode CLI interaction is a single
// best-effort export probe.
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

// Chars-per-token estimate for transcript JSON. Deliberately underestimates
// (real ratio is ~3-4) so the check errs toward compacting.
export const DIGEST_CHARS_PER_TOKEN = 4;
// ponytail: fixed reserve for OpenCode's own system prompt + tool schemas;
// recalibrate from real overflow traces if compaction still under-reserves.
export const SYSTEM_RESERVE_TOKENS = 16_000;
export const MIN_DIGEST_TOKENS = 4_000;
// Cap for a digest persisted in sessionParams so the stored payload stays small.
export const STORAGE_DIGEST_MAX_CHARS = 12_000;
// Per-turn text cap inside a digest; stops one giant tool output eating the budget.
const TURN_TEXT_MAX_CHARS = 8_000;

export interface OpenCodeModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

export interface OpenCodeSessionExport {
  tokens: number;
  json: string;
}

const MODEL_ID_LINE_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Parse `opencode models --verbose [provider]` stdout. Each model id line is
 * followed by a JSON block whose `limit` carries the context/output token
 * budgets. Returns the limits for the exact provider/model id, or null when
 * the output does not cover it.
 */
export function parseOpenCodeModelLimitsOutput(stdout: string, modelId: string): OpenCodeModelLimits | null {
  const target = modelId.trim();
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== target) continue;
    let start = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const trimmed = lines[j].trim();
      if (trimmed.startsWith("{")) {
        start = j;
        break;
      }
      if (MODEL_ID_LINE_RE.test(trimmed)) break;
    }
    if (start === -1) continue;
    let end = -1;
    let depth = 0;
    scan: for (let j = start; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break scan;
          }
        }
      }
    }
    if (end === -1) continue;
    try {
      const block = JSON.parse(lines.slice(start, end + 1).join("\n")) as {
        limit?: { context?: unknown; output?: unknown };
      };
      const contextWindow = Number(block.limit?.context);
      const maxOutputTokens = Number(block.limit?.output);
      if (
        Number.isFinite(contextWindow) &&
        contextWindow > 0 &&
        Number.isFinite(maxOutputTokens) &&
        maxOutputTokens > 0
      ) {
        return { contextWindow, maxOutputTokens };
      }
    } catch {
      // malformed block; keep scanning for another occurrence
    }
  }
  return null;
}

/** Estimate transcript size in tokens from raw export JSON (chars / 4, ceil). */
export function estimateOpenCodeSessionTokens(exportJson: string): number {
  return Math.ceil(exportJson.length / DIGEST_CHARS_PER_TOKEN);
}

/**
 * Probe `opencode export <sessionId>` and report its raw size. Best effort:
 * any failure (older CLI without the flag, remote storage not visible here,
 * timeout) yields null, which callers treat as "size unknown" and compact
 * conservatively.
 */
export async function exportOpenCodeSession(input: {
  command: string;
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec?: number;
}): Promise<OpenCodeSessionExport | null> {
  try {
    const result = await runChildProcess(
      `opencode-export-${input.sessionId}`,
      input.command,
      ["export", input.sessionId],
      {
        cwd: input.cwd,
        env: input.env,
        timeoutSec: input.timeoutSec ?? 60,
        graceSec: 3,
        onLog: async () => {},
      },
    );
    if (result.timedOut || (result.exitCode ?? 1) !== 0) return null;
    if (!result.stdout.trim()) return null;
    return { tokens: estimateOpenCodeSessionTokens(result.stdout), json: result.stdout };
  } catch {
    return null;
  }
}

interface DigestMessage {
  info?: { role?: unknown };
  parts?: Array<{ type?: unknown; text?: unknown }>;
}

/**
 * Render a tail-bounded digest of an `opencode export` JSON: the most recent
 * text turns that fit `budgetChars` (header included), oldest first. This
 * becomes the seed prompt for the fresh session replacing a compacted one.
 */
export function buildOpenCodeSessionDigest(exportJson: string, budgetChars: number, sessionId: string): string {
  const header =
    `[paperclip] Session "${sessionId}" was compacted because its transcript would exceed the model's context window. ` +
    `Earlier turns were dropped; the most recent turns follow as working context.\n\n`;
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(exportJson) as { messages?: unknown };
  } catch {
    return `${header}(transcript export could not be parsed; no earlier turns retained.)`;
  }
  const messages = Array.isArray(parsed.messages) ? (parsed.messages as DigestMessage[]) : [];
  const budget = Math.max(0, budgetChars - header.length);
  if (budget <= 0 || messages.length === 0) return `${header}(no earlier turns retained.)`;
  const kept: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = typeof message?.info?.role === "string" ? message.info.role : "assistant";
    const text = (Array.isArray(message?.parts) ? message.parts : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0)
      .map((part) => {
        const value = String(part.text);
        return value.length > TURN_TEXT_MAX_CHARS
          ? `${value.slice(value.length - TURN_TEXT_MAX_CHARS)}\n…[older text truncated]`
          : value;
      })
      .join("\n")
      .trim();
    if (!text) continue;
    const entry = `## turn ${i + 1} of ${messages.length} (${role})\n${text}`;
    if (kept.length === 0) {
      kept.push(entry.length > budget ? `${entry.slice(0, Math.max(0, budget))}\n…[truncated]` : entry);
      used = Math.min(entry.length, budget);
      if (entry.length >= budget) break;
    } else {
      const cost = entry.length + 2;
      if (used + cost > budget) break;
      kept.push(entry);
      used += cost;
      if (used >= budget) break;
    }
  }
  if (kept.length === 0) return `${header}(no earlier turns retained.)`;
  return header + kept.reverse().join("\n\n");
}

/** Bound a digest for persistence in sessionParams (tail kept, marker prepended). */
export function compactOpenCodeDigestForStorage(digest: string, maxChars: number = STORAGE_DIGEST_MAX_CHARS): string {
  const value = digest.trim();
  if (value.length <= maxChars) return value;
  const marker = "…[older digest truncated]\n";
  return `${marker}${value.slice(value.length - Math.max(0, maxChars - marker.length))}`;
}

export interface ResumeCompactionDecision {
  compact: boolean;
  digestTokenBudget: number;
}

/**
 * Decide whether a resumed session should be compacted. `estimateTokens` is
 * null when the session could not be sized; unknown is treated as overflow
 * so we seed a bounded context instead of betting on a hard fail.
 */
export function decideResumeCompaction(input: {
  estimateTokens: number | null;
  contextWindow: number;
  maxOutputTokens: number;
  freshPromptChars: number;
}): ResumeCompactionDecision {
  const promptReserveTokens = Math.ceil(input.freshPromptChars / DIGEST_CHARS_PER_TOKEN);
  const digestTokenBudget = Math.max(
    MIN_DIGEST_TOKENS,
    input.contextWindow - input.maxOutputTokens - SYSTEM_RESERVE_TOKENS - promptReserveTokens,
  );
  const compact = input.estimateTokens === null || input.estimateTokens > digestTokenBudget;
  return { compact, digestTokenBudget };
}

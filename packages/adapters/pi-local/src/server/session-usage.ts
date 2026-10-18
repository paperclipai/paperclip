import { promises as fs } from "node:fs";

/**
 * Session-file usage recovery for the pi_local adapter.
 *
 * A killed Pi process (operator interrupt, graceful server shutdown, timeout,
 * or crash) never returns a final usage result, and the live stdout stream can
 * lose its tail while the server is shutting down. The Pi session JSONL is the
 * durable record of every completed assistant turn, so it is the authoritative
 * source for recovering usage of an interrupted run.
 *
 * Usage rules (ROG-189):
 * - Sum the usage of every completed assistant message; a partial in-flight
 *   turn is never written to the session file and is therefore excluded.
 * - Deduplicate by the session record id so replayed or rewritten lines cannot
 *   double-count a turn.
 * - Filter by an optional [from, to] window so a session resumed by a later
 *   run attributes its earlier turns to the run that produced them.
 */

export interface PiSessionUsageSummary {
  /** Number of distinct completed assistant messages counted. */
  responses: number;
  usage: {
    /** Uncached input tokens. */
    inputTokens: number;
    /** Cache-read tokens, tracked separately from inputTokens. */
    cachedInputTokens: number;
    /** Cache-write tokens (subset of inputTokens). */
    cacheWriteTokens: number;
    outputTokens: number;
  };
  /** Sum of the session's per-message cost totals, or null when any message
   * lacked a usable cost (never guess a partial price). */
  costUsd: number | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  /** Last observed provider/model, useful for receipt attribution. */
  provider: string | null;
  model: string | null;
}

interface PiSessionMessageUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown } | null;
}

const recordUsage = (message: Record<string, unknown>): PiSessionMessageUsage | null => {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return usage as PiSessionMessageUsage;
};

const countable = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const costable = (value: unknown): number | null => {
  const cost = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return cost;
};

/** Parse the complete usage summary of a Pi session JSONL file.
 * Returns null when the file is missing, unreadable, or not a session file. */
export async function readPiSessionUsage(
  sessionPath: string,
  window?: { from?: string | Date | null; to?: string | Date | null },
): Promise<PiSessionUsageSummary | null> {
  if (!sessionPath.trim()) return null;
  let contents: string;
  try {
    contents = await fs.readFile(sessionPath, "utf8");
  } catch {
    return null;
  }
  const from = window?.from ? new Date(window.from).getTime() : null;
  const to = window?.to ? new Date(window.to).getTime() : null;
  if ((from !== null && Number.isNaN(from)) || (to !== null && Number.isNaN(to))) return null;

  const summary: PiSessionUsageSummary = {
    responses: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    costUsd: 0,
    firstMessageAt: null,
    lastMessageAt: null,
    provider: null,
    model: null,
  };
  const seen = new Set<string>();
  let sawSessionHeader = false;
  let sawAssistantMessage = false;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "session") {
      sawSessionHeader = true;
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role !== "assistant") continue;
    const usage = recordUsage(messageRecord);
    if (!usage) continue;

    const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
    const at = timestamp !== null ? new Date(timestamp).getTime() : null;
    if (at !== null && !Number.isNaN(at)) {
      if (from !== null && at < from) continue;
      if (to !== null && at > to) continue;
    }
    const id = typeof record.id === "string" && record.id.length > 0 ? record.id : line;
    if (seen.has(id)) continue;
    seen.add(id);

    const input = countable(usage.input) ?? 0;
    const cachedInput = countable(usage.cacheRead) ?? 0;
    const cacheWrite = countable(usage.cacheWrite) ?? 0;
    const output = countable(usage.output) ?? 0;
    const total = usage.cost ? costable(usage.cost.total) : null;
    sawAssistantMessage = true;
    summary.responses += 1;
    summary.usage.inputTokens += input;
    summary.usage.cachedInputTokens += cachedInput;
    summary.usage.cacheWriteTokens += cacheWrite;
    summary.usage.outputTokens += output;
    if (total === null) {
      summary.costUsd = null;
    } else if (summary.costUsd !== null) {
      summary.costUsd += total;
    }
    if (timestamp !== null) {
      summary.firstMessageAt ??= timestamp;
      summary.lastMessageAt = timestamp;
    }
    if (typeof messageRecord.provider === "string" && messageRecord.provider.length > 0) {
      summary.provider = messageRecord.provider;
    }
    if (typeof messageRecord.model === "string" && messageRecord.model.length > 0) {
      summary.model = messageRecord.model;
    }
  }

  if (!sawSessionHeader) return null;
  if (!sawAssistantMessage) {
    summary.costUsd = null;
  }
  return summary;
}

import type { AdapterUsageCheckpoint } from "./types.js";

/** Project accounting protocol fields before retaining a stream snapshot.
 * Content-bearing strings are never retained in the accounting buffer. */
const fields = new Set([
  "type", "subtype", "role", "id", "session_id", "sessionID", "thread_id", "model", "modelID", "providerID",
  "usage", "usageMetadata", "modelUsage", "message", "part", "info", "stats", "tokens", "cost", "total",
  "input", "output", "cache", "read", "write", "input_tokens", "output_tokens", "cached_input_tokens",
  "cache_read_input_tokens", "cache_creation_input_tokens", "inputTokens", "outputTokens", "cacheReadInputTokens",
  "cacheCreationInputTokens", "cachedInputTokens", "promptTokenCount", "candidatesTokenCount", "cachedContentTokenCount",
  "reasoning", "cacheRead", "cacheWrite", "prompt", "candidates", "totalTokenCount", "total_tokens", "toolUsePromptTokenCount", "messages",
  "thoughtsTokenCount", "inputTokens", "totalTokens", "cached", "thoughts", "total_cost_usd", "cost_usd", "costUSD", "costUsd",
]);
const stringFields = new Set(["type", "subtype", "role", "id", "session_id", "sessionID", "thread_id", "model", "modelID", "providerID"]);
function project(value: unknown, depth = 0, field = ""): unknown {
  if (depth > 8) return undefined;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "string") return stringFields.has(field) ? value.slice(0, 250) : undefined;
  if (Array.isArray(value)) return value.slice(0, 500).map(item => project(item, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key))
    .map(([key, entry]) => [key, key === "modelUsage" && entry && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry).map(([model, usage]) => [model.slice(0, 250), project(usage, depth + 1)]))
      : project(entry, depth + 1, key)]));
}

/** The consumer incrementally parses only new records (never the full history).
 * A fresh instance belongs to one CLI attempt. Call flush() after its process
 * exits, before retrying or final result handling. Checkpoint failures are
 * retained outside runChildProcess's best-effort onLog error handler. */
export function createUsageCheckpointLog(
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
  onUsage: ((receipt: AdapterUsageCheckpoint) => Promise<void>) | undefined,
  consume: (records: string) => AdapterUsageCheckpoint | null,
) {
  const attemptId = randomUUID();
  let remainder = "", accounting = "", previous = "";
  let snapshot: AdapterUsageCheckpoint | null = null;
  let failure: unknown;
  let failed = false;
  function retain(line: string) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return; }
    const compact = JSON.stringify(project(raw));
    if (!compact || !/usage|tokens|cost|"result"|"turn.completed"|"agent_end"|"model"|"modelID"/.test(compact)) return;
    accounting += compact + "\n";
    if (accounting.length > 8 * 1024 * 1024) throw new Error("Accounting checkpoint chunk exceeds 8 MiB");
  }
  async function publish(complete = false) {
    if (!onUsage) return;
    if (accounting) {
      snapshot = consume(accounting);
      accounting = "";
    }
    const parsed = snapshot;
    if (!parsed) return;
    if (!parsed.complete && parsed.costUsd == null && parsed.costUsdExact == null &&
      !Object.values(parsed.usage ?? {}).some(value => typeof value === "number" && value > 0)) return;
    const receipt = { ...parsed, complete: parsed.complete || complete };
    const serialized = JSON.stringify(receipt);
    if (serialized !== previous) { await onUsage({ ...receipt, attemptId }); previous = serialized; }
  }
  const log = async (stream: "stdout" | "stderr", chunk: string) => {
    if (onUsage && !failed && stream === "stdout") {
      try {
        remainder += chunk;
        const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
        if (remainder.length > 8 * 1024 * 1024) throw new Error("Accounting protocol line exceeds 8 MiB");
        for (const line of lines) retain(line);
        await publish();
      } catch (error) {
        failed = true; failure = error; remainder = ""; accounting = "";
      }
    }
    // Receipt persistence and ordinary logs have separate failure contracts.
    // A failed receipt must not hide the provider's diagnostic output.
    await onLog(stream, chunk);
  };
  return Object.assign(log, {
    async flush(options: { complete?: boolean } = {}) {
      if (failed) throw failure;
      if (!onUsage) return;
      if (remainder) { retain(remainder); remainder = ""; }
      await publish(options.complete ?? false);
    },
  });
}
import { randomUUID } from "node:crypto";

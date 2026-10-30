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
/** Distinguish damaged accounting from ignored metadata. A private sentinel
 * marks each numeric replacement through projection. Only a projection with no
 * surviving sentinel may be consumed; damaged counters are never reconstructed. */
function projectRedactedRecord(line: string, isCostRecord?: (event: Record<string, unknown>) => boolean) {
  try {
    const marker = randomUUID();
    const classification = line.replace(
      /"(?:[^"\\]|\\.)*"|(?:[-+\d.eE]*\*\*\*REDACTED\*\*\*)+[-+\d.eE]*/g,
      token => token.startsWith('"') ? token : JSON.stringify(marker),
    );
    const event = JSON.parse(classification, (_key, value) => value === marker ? Number.NaN : value);
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    let damaged = false;
    const compact = JSON.stringify(project(event), (_key, value) => {
      if (typeof value === "number" && Number.isNaN(value)) damaged = true;
      return value;
    });
    if (!damaged) return { compact, lost: false };
    const usage = event.type === "turn_end" ? event.message?.usage : event.usage;
    const accountingEnvelope = isCostRecord ? isCostRecord(event) : event.type === "step_finish" ||
      (usage !== null && typeof usage === "object" && !Array.isArray(usage));
    return { compact: "", lost: accountingEnvelope };
  } catch {
    return null;
  }
}
function project(value: unknown, depth = 0, field = ""): unknown {
  if (depth > 8) return undefined;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  // Retain an invalid-type marker without retaining its contents. Omitting a
  // malformed optional counter would let parsers default it to a valid zero.
  if (typeof value === "string") return stringFields.has(field) ? value.slice(0, 250) : false;
  if (Array.isArray(value)) return value.slice(0, 500).map(item => project(item, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key))
    .map(([key, entry]) => [key, key === "modelUsage" && entry && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry).map(([model, usage]) => [model.slice(0, 250), project(usage, depth + 1)]))
      : project(entry, depth + 1, key)]));
}

/** Bound strings before buffering whole JSON lines. Provider records can carry
 * many MiB of conversation text alongside a small usage object. Preserve JSON
 * escapes across chunks so discarded text cannot corrupt the accounting fields. */
function createStringCompactor() {
  let inString = false, length = 0, escapeRemaining = 0;
  let escapeCode = false, keepEscape = false;
  return (chunk: string) => {
    let output = "";
    for (const character of chunk) {
      if (character === "\n") {
        inString = false; escapeRemaining = 0; escapeCode = false;
        output += character;
      } else if (!inString) {
        output += character;
        if (character === '"') { inString = true; length = 0; }
      } else if (escapeRemaining > 0) {
        if (keepEscape) output += character;
        escapeRemaining = escapeCode && character === "u" ? 4 : escapeRemaining - 1;
        escapeCode = false;
        length++;
      } else if (character === '"') {
        output += character; inString = false;
      } else if (character === "\\") {
        keepEscape = length < 250;
        if (keepEscape) output += character;
        escapeRemaining = 1; escapeCode = true; length++;
      } else {
        if (length < 250) output += character;
        length++;
      }
    }
    return output;
  };
}

/** The consumer incrementally parses only new records (never the full history).
 * A fresh instance belongs to one CLI attempt. Call flush() after its process
 * exits, before retrying or final result handling. Checkpoint failures are
 * retained outside runChildProcess's best-effort onLog error handler. */
export function createUsageCheckpointLog(
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
  onUsage: ((receipt: AdapterUsageCheckpoint) => Promise<void>) | undefined,
  consume: (records: string) => AdapterUsageCheckpoint | null,
  isCostRecord?: (event: Record<string, unknown>) => boolean,
  options: { trackLossWithoutSubscriber?: boolean } = {},
) {
  const tracking = Boolean(onUsage || options.trackLossWithoutSubscriber);
  const attemptId = randomUUID();
  const compactStrings = createStringCompactor();
  let remainder = "", accounting = "", previous = "";
  let snapshot: AdapterUsageCheckpoint | null = null;
  let failure: unknown;
  let failed = false;
  let unreadRecords = 0;
  function retain(line: string) {
    if (!onUsage && !line.includes(REDACTED_SECRET_ENV_VALUE)) return;
    let compact: string | undefined;
    try { compact = JSON.stringify(project(JSON.parse(line))); } catch {
      if (!line.includes(REDACTED_SECRET_ENV_VALUE)) return;
      const projected = projectRedactedRecord(line, isCostRecord);
      if (!projected) return;
      if (projected.lost) unreadRecords++;
      compact = projected.compact;
    }
    // Loss-only tracking never invokes the checkpoint parser or retains its input.
    if (!onUsage || !compact || !/usage|tokens|cost|"result"|"turn.started"|"turn.completed"|"turn.failed"|"error"|"agent_end"|"step_finish"|"model"|"modelID"/.test(compact)) return;
    accounting += compact + "\n";
    if (accounting.length > 8 * 1024 * 1024) throw new Error("Accounting checkpoint chunk exceeds 8 MiB");
  }
  function recordFailure(error: unknown) {
    failed = true; failure = error; remainder = ""; accounting = "";
    // Optional observation must not fail a successful run. Stop buffering and
    // retain an incomplete verdict when its bounded view cannot classify more.
    if (!onUsage) unreadRecords++;
  }
  async function publish(complete = false) {
    if (!onUsage) return;
    if (accounting) {
      snapshot = consume(accounting);
      accounting = "";
    }
    const parsed = snapshot;
    if (!parsed) return;
    const receipt: AdapterUsageCheckpoint = { ...parsed, complete: parsed.complete || complete };
    if (unreadRecords > 0) {
      // A terminal event or clean process exit cannot restore lost records.
      // These totals are lower bounds, not complete usage or a complete price.
      const usage = parsed.usage ? { ...parsed.usage } : undefined;
      if (usage && "costUsd" in usage) usage.costUsd = null;
      Object.assign(receipt, { complete: false, usage, costUsd: null, costUsdExact: null,
        cacheAdjustedCostUsd: null, usageByModel: undefined, costStatus: "unpriced" });
    }
    if (!receipt.complete && receipt.costStatus !== "unpriced" && receipt.costUsd == null && receipt.costUsdExact == null &&
      !Object.values(receipt.usage ?? {}).some(value => typeof value === "number" && value > 0)) return;
    const serialized = JSON.stringify(receipt);
    if (serialized !== previous) { await onUsage({ ...receipt, attemptId }); previous = serialized; }
  }
  const log = async (stream: "stdout" | "stderr", chunk: string) => {
    if (tracking && !failed && stream === "stdout") {
      try {
        remainder += compactStrings(chunk);
        const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
        if (remainder.length > 8 * 1024 * 1024) throw new Error("Accounting protocol line exceeds 8 MiB");
        for (const line of lines) retain(line);
        await publish();
      } catch (error) {
        recordFailure(error);
      }
    }
    // Receipt persistence and ordinary logs have separate failure contracts.
    // A failed receipt must not hide the provider's diagnostic output.
    await onLog(stream, chunk);
  };
  return Object.assign(log, {
    /** Lost accounting records, including a loss-only observer's bounded-view failure. */
    unreadRecords: () => unreadRecords,
    async flush(options: { complete?: boolean } = {}) {
      if (failed) { if (onUsage) throw failure; return; }
      if (!tracking) return;
      try {
        if (remainder) { retain(remainder); remainder = ""; }
        await publish(options.complete ?? false);
      } catch (error) {
        recordFailure(error);
        if (onUsage) throw error;
      }
    },
  });
}
import { randomUUID } from "node:crypto";
import { REDACTED_SECRET_ENV_VALUE } from "./secret-env-redaction.js";

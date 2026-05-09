# Openrouter-agent adapter phase 3 design

## Scope

This document addresses the issues identified in the post-phase-2 critique. Phase 2 extracted the adapter from `openrouter-local`, established the tool dispatch architecture, and fixed the tool result encoding problem. Phase 3 focuses on correctness, reliability, and operational quality — the gaps that will surface at production scale.

Issues are grouped by theme and ordered by severity within each theme.

---

## 1. Context window management

### Problem

The `messages` array in `execute.ts` grows unboundedly. Every tool call, tool result, and assistant turn is appended and never removed. Models have fixed context windows; when the accumulated token count exceeds the limit, the API returns an error and the run fails. The other adapters delegate this to their underlying CLIs (Claude Code has compaction built in). This adapter has nothing.

### Design

Introduce a **compaction step** that fires when the conversation approaches a configurable token threshold. Rather than a hard truncation (which corrupts the conversation structure), we use the model itself to produce a summary of the conversation so far, then replace old messages with that summary.

#### Token tracking

We already accumulate `state.inputTokens` from each completion's usage block. This is the authoritative signal: when the latest completion reports `prompt_tokens > compactionThreshold`, the _next_ iteration should compact before calling the model again.

```ts
// New config key
const compactionThreshold = asInt(config.compactionThreshold, 80_000);
// 0 = disabled

// In the iteration loop, before the API call:
if (compactionThreshold > 0 && state.inputTokens > compactionThreshold) {
  messages = await compactMessages(messages, client, model, controller?.signal);
  state.inputTokens = 0; // reset; next completion will report fresh usage
}
```

#### Compaction algorithm

```
compactMessages(messages, client, model, signal):
  1. Separate: systemMsg (index 0, if kind === "system"), tail (last KEEP_TAIL messages), middle (everything between).
  2. If middle is empty, nothing to compact — return as-is.
  3. Build a compaction prompt:
       "Summarize the following conversation history concisely. Preserve all task context,
        decisions made, files modified, and tool results that are still relevant. Omit
        repetitive tool output and intermediate reasoning.\n\n<history>..."
  4. Call the model (same model, no tools, max_tokens = 2048).
  5. Replace middle with a single synthetic user message:
       { role: "user", content: "[Conversation summary]\n" + summaryText }
  6. Return [systemMsg?, summaryUserMsg, ...tail].
```

`KEEP_TAIL` defaults to 6 messages (3 tool call/result pairs), ensuring the model has immediate context. This is configurable via `compactionKeepTail`.

#### Trade-offs

- **Compaction call costs tokens and latency.** Acceptable — it only fires once per threshold crossing, and the alternative is a hard failure.
- **Summary loses precision.** Tool output detail in older turns is reduced to prose. This is unavoidable without a larger context window and is preferable to crashing.
- **Threshold must be below the model's actual limit.** Callers should set `compactionThreshold` below the model's context window size. There is no automatic discovery of this value (see §8 for the model metadata approach).

#### New config keys

| Key | Default | Description |
|-----|---------|-------------|
| `compactionThreshold` | `80000` | Input token count that triggers compaction. `0` disables. |
| `compactionKeepTail` | `6` | Messages to keep verbatim after the summary. |

---

## 2. `isError` inconsistency

### Problem

When a Paperclip API call fails, `formatApiError` returns an error object as the tool result _content_, but `ToolDispatchOutcome.isError` stays `false`. The transcript shows `isError: false` for a failed API call, which is wrong. The UI does not highlight it as an error; the audit trail is incorrect.

### Design

Introduce a `ToolResultError` class. Handlers throw it (or return it via a helper) when they want to produce a structured error that propagates `isError: true` through the dispatch layer.

```ts
// tools.ts
export class ToolResultError extends Error {
  readonly content: Record<string, unknown>;
  constructor(content: Record<string, unknown>) {
    super(String(content.message ?? "tool error"));
    this.name = "ToolResultError";
    this.content = content;
  }
}
```

`dispatchToolCall` catches it specifically:

```ts
export async function dispatchToolCall(...): Promise<ToolDispatchOutcome> {
  ...
  try {
    const result = await handler.execute(args, ctx);
    const content = typeof result === "string" ? truncateForModel(result) : result;
    return { content, isError: false };
  } catch (err) {
    if (err instanceof ToolResultError) {
      return { content: err.content, isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: `error: ${message}`, isError: true };
  }
}
```

`paperclip-tools.ts` handlers throw instead of returning:

```ts
// before
} catch (err) {
  return formatApiError(err);
}

// after
} catch (err) {
  throw new ToolResultError(formatApiError(err));
}
```

`formatApiError` returns `Record<string, unknown>` as it already does after phase 2 — no change there.

#### Trade-offs

- **Handlers can no longer silently absorb errors.** This is the desired behaviour. If a handler genuinely wants to return an informational error message without setting `isError`, it can return a structured object (not throw). The distinction is now explicit.
- **`ToolResultError` is in the adapter package.** It does not need to be in `adapter-utils`. If other adapters eventually need the same pattern, it can be moved then.

---

## 3. Streaming

### Problem

`client.chat.completions.create` with no `stream` flag waits for the full response. During long generations the UI shows nothing. Every other adapter emits incremental output.

### Design

Switch to `client.chat.completions.create({ ..., stream: true })`, which returns an `AsyncIterable` of delta chunks. We accumulate the full message as we stream, emitting to the transcript incrementally.

#### Streaming transcript protocol

The `TranscriptEntry` type supports `delta: true` on `assistant` and `thinking` entries. The UI renders these as streaming text.

```ts
// First assistant chunk: emit with delta: true
await emit({ kind: "assistant", ts, text: chunk, delta: true });

// Subsequent chunks: emit with delta: true (UI appends)
await emit({ kind: "assistant", ts, text: chunk, delta: true });

// After stream closes: emit the full accumulated text with delta: false (or omit delta)
await emit({ kind: "assistant", ts, text: fullText });
```

However, managing two assistant entries (delta stream + final) is complex and may cause UI duplication depending on how the transcript view handles it. A simpler protocol: emit one `assistant` entry with `delta: true` per chunk, and no final non-delta entry. The transcript view already handles this.

#### Tool call accumulation

Tool call arguments arrive as partial JSON across multiple delta chunks. The accumulation is index-based:

```ts
const toolCallAccumulator = new Map<number, {
  id: string;
  name: string;
  argumentsBuffer: string;
}>();

for await (const chunk of stream) {
  for (const delta of chunk.choices[0]?.delta?.tool_calls ?? []) {
    const acc = toolCallAccumulator.get(delta.index) ?? { id: "", name: "", argumentsBuffer: "" };
    if (delta.id) acc.id = delta.id;
    if (delta.function?.name) acc.name = delta.function.name;
    if (delta.function?.arguments) acc.argumentsBuffer += delta.function.arguments;
    toolCallAccumulator.set(delta.index, acc);
  }
}
```

Tool calls are dispatched after the stream closes, same as the current non-streaming path.

#### Reasoning streaming

OpenRouter surfaces reasoning via non-standard fields (`reasoning_details`, `reasoning`). These may not arrive as deltas. The safe approach is to collect them post-stream (same as today) and emit a single `thinking` entry. If a provider does stream reasoning deltas, we can add delta emission in a follow-up.

#### Trade-offs

- **Streaming is not universally supported.** Some OpenRouter providers do not support streaming. The adapter should catch stream errors and fall back to non-streaming for that completion. A `streamingFallback: true` config flag (default on) controls this.
- **Cost tracking still requires a post-stream fetch.** The `id` needed for the OpenRouter `/generation` endpoint comes from the stream's final chunk. This does not change the cost-fetch design.
- **Testing is harder with streams.** The existing mock factory pattern in `execute.test.ts` will need extension to return mock `AsyncIterable` completions.

#### New config key

| Key | Default | Description |
|-----|---------|-------------|
| `disableStreaming` | `false` | Falls back to non-streaming if `true`. Useful for providers that don't support it. |

---

## 4. Retry and backoff in `PaperclipApi`

### Problem

`PaperclipApi` is a thin fetch wrapper with no retry logic. A 429 or transient 5xx during a tool call causes immediate failure. For a long-running agentic loop this will happen on any busy deployment.

### Design

Add a `fetchWithRetry` utility inside `paperclip-api.ts`. It is not exported — it is an internal implementation detail.

```ts
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const baseDelay = 1000 * 2 ** (attempt - 1); // 1s, 2s
      const jitter = Math.random() * 500;
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
    }
    const res = await fetch(url, init);
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter ? parseFloat(retryAfter) * 1000 : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
      lastError = new PaperclipApiError(429, { message: "rate limited" }, url);
      continue;
    }
    if (res.status >= 500 && res.status < 600) {
      lastError = new PaperclipApiError(res.status, { message: "server error" }, url);
      continue;
    }
    return res; // 2xx and 4xx (non-429) are returned as-is for the caller to handle
  }
  throw lastError;
}
```

All `PaperclipApi` methods switch from `fetch(...)` to `fetchWithRetry(...)`.

**Retried:** 429, 500, 502, 503, 504.  
**Not retried:** 400, 401, 403, 404, 409 — these are deterministic and retrying them wastes time.

The OpenAI SDK already handles its own retries for model API calls. This retry logic covers only the Paperclip control-plane calls.

---

## 5. `checkoutIssue` failure handling

### Problem

If `checkoutIssue` fails for any reason other than 409 (locked), the adapter logs a warning and continues. This is unsafe: proceeding without a confirmed checkout means two runs may operate concurrently on the same issue.

### Design

Classify errors into three buckets:

```
409 Conflict  → abort, return { errorCode: "issue_locked" }   (current, correct)
401/403       → abort, return { errorCode: "auth_error" }      (new)
4xx other     → abort, return { errorCode: "checkout_failed" } (new)
Network/5xx   → retry via fetchWithRetry (§4), then abort if all retries fail
```

The "log and continue" path is removed entirely. Any failure that is not resolved by retry is a hard abort before any tool calls are made. This is the correct default. A `looseCheckout: true` config flag can restore the old behaviour for local development where the checkout API may not be running.

---

## 6. Stall detection

### Problem

The iteration cap (`maxIterations`) is the only safeguard against infinite loops. A model that repeatedly calls the same tool with the same arguments will exhaust it silently and terminate without completing the task.

### Design

Track a hash of each tool call's `(name, arguments)` pair. If the same signature appears in two consecutive iterations, increment a stall counter. After `maxStallIterations` consecutive stall-detected iterations (default: 3), abort with `errorCode: "stall_detected"`.

```ts
function toolCallSignature(call: ChatCompletionMessageToolCall): string {
  return `${call.function.name}:${call.function.arguments}`;
}

// In the loop:
const currentSignatures = new Set(toolCalls.map(toolCallSignature));
const stalledCalls = [...currentSignatures].filter((s) => lastSignatures.has(s));
if (stalledCalls.length > 0) {
  stallCount++;
} else {
  stallCount = 0;
}
lastSignatures = currentSignatures;

if (stallCount >= maxStallIterations) {
  return { exitCode: 1, errorCode: "stall_detected", errorMessage: `Stall detected after ${stallCount} repeated calls to: ${stalledCalls.join(", ")}` };
}
```

**Trade-offs:** A model may legitimately call the same tool twice (e.g., `get_issue` to check status after updating it). The consecutive check reduces false positives — the same call must repeat in adjacent iterations, not just appear twice in a run. The counter resets on any novel call, so one legitimate repeat is forgiven.

#### New config key

| Key | Default | Description |
|-----|---------|-------------|
| `maxStallIterations` | `3` | Consecutive same-call iterations before aborting as stalled. `0` disables. |

---

## 7. `serializeForModel` truncation order

### Problem

`serializeForModel` calls `JSON.stringify(content, null, 2)` (which inflates size by ~25–30%) before applying the 256KB byte truncation. A 200KB API response becomes ~250KB after pretty-printing, then gets truncated mid-object. The model receives malformed JSON.

### Design

Truncation must apply after serialization but the limit should account for the inflation. Two options:

**Option A — truncate the compact form, emit the pretty form if it fits:**

```ts
export function serializeForModel(content: unknown): string {
  if (typeof content === "string") return truncateForModel(content);
  const compact = JSON.stringify(content);
  if (Buffer.byteLength(compact, "utf-8") > MAX_OUTPUT_BYTES) {
    // Too large even compact — truncate the compact form (valid JSON up to cut point is lost,
    // but we indicate truncation rather than silently mangling).
    return truncateForModel(compact);
  }
  // Fits compact, so pretty-print is safe (it will be larger, but within reason).
  return JSON.stringify(content, null, 2);
}
```

**Option B — truncate at the object level (prune arrays, drop null fields):**

Prune fields before serialization: drop null/undefined values, truncate arrays to the first N items, add a `_truncated: true` marker. This produces well-formed output at any size but requires domain knowledge of which fields to prune. Better suited as a future enhancement.

**Recommendation: Option A.** It is correct, minimal, and contained to one function.

---

## 8. Generation cost fetch reliability

### Problem

The 800ms fixed delay before fetching generation cost from OpenRouter's `/generation` endpoint is a heuristic. If OpenRouter is slow to process the generation data, the fetch returns nothing and `costUsd` is silently reported as `$0`.

### Design

Replace the single-attempt fetch with a bounded retry:

```ts
async function fetchGenerationCost(
  id: string,
  apiKey: string,
  maxAttempts = 4,
  baseDelayMs = 800,
): Promise<{ costUsd: number; providerName: string | null }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    const result = await fetchGenerationCostOnce(id, apiKey);
    if (result.costUsd > 0) return result;
  }
  return { costUsd: 0, providerName: null };
}
```

Delays: 800ms, 1.6s, 2.4s, 3.2s. Max additional wait: ~8s. If cost is still unavailable, we accept $0 rather than blocking indefinitely. Total max wait is unchanged for the common case (data available immediately after first delay) and bounded for the pathological case.

The `generationFetchDelayMs` test override becomes `generationFetchBaseDelayMs` and still short-circuits correctly in tests via `0`.

---

## 9. Transcript encoding regression test

### Problem

There is no test that asserts the wire format of `tool_result` transcript entries. The phase 2 encoding fix can regress silently.

### Design

Add a test case in `execute.test.ts` that:

1. Configures a mock tool that returns a structured object (simulating a Paperclip API tool).
2. Configures the mock OpenAI client to request that tool once, then return a final answer.
3. Captures all `onLog("stdout", ...)` calls.
4. Asserts that the emitted `tool_result` entry has `content` as an object (not a JSON string), and that `JSON.parse` of the emitted line produces the expected structure.

```ts
it("emits tool_result with structured content object, not pre-stringified string", async () => {
  const structuredResult = { id: "abc", title: "Test issue", status: "open" };
  const structuredTool: ToolHandler = {
    name: "get_issue",
    description: "test",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return structuredResult; },
  };
  // ... mock client returns tool call then stops ...
  const lines = stdoutLines.filter((l) => {
    try { return JSON.parse(l).kind === "tool_result"; } catch { return false; }
  });
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]);
  expect(typeof entry.content).toBe("object");
  expect(entry.content).toEqual(structuredResult);
  expect(entry.isError).toBe(false);
});
```

---

## 10. `ui-parser.ts` comment accuracy

### Problem

The module-level comment says every entry conforms to the `TranscriptEntry` union from `@paperclipai/adapter-utils`. After phase 2, `tool_result.content` is `unknown` in the local type — a deliberate divergence from the shared type's `content: string`.

### Design

Update the comment to document the divergence:

```ts
// The execute loop emits one JSON object per stdout line. Most entries conform
// to the TranscriptEntry union from @paperclipai/adapter-utils. One intentional
// divergence: tool_result entries emit `content` as a raw JSON value (object or
// string) rather than a pre-serialized string, so the UI receives structured
// data without escape-quoting overhead. The shared type's content: string
// constraint is not violated at runtime — the UI's formatToolPayload() accepts
// unknown and handles both cases.
```

This is a documentation-only change.

---

## Implementation sequence

| Priority | § | Item | Effort | Time | Model | Risk |
|----------|---|------|--------|------|-------|------|
| 1 | 10 | `ui-parser.ts` comment | Trivial | 5 min | Haiku 4.5 | None |
| 2 | 7 | `serializeForModel` truncation fix | Low | 30 min | Haiku 4.5 | Low — one function |
| 3 | 5 | `checkoutIssue` hard abort | Low | 45 min | Haiku 4.5 | Low — tightens existing logic |
| 4 | 8 | Generation cost fetch retry | Low | 1 h | Haiku 4.5 | Low — bounded wait |
| 5 | 2 | `ToolResultError` + handler updates + test fixes | Low | 2 h | Haiku 4.5 | Low — narrow, well-tested |
| 6 | 4 | `PaperclipApi` retry/backoff | Medium | 3 h | Sonnet 4.6 | Low — isolated to one file |
| 7 | 6 | Stall detection | Medium | 3 h | Sonnet 4.6 | Medium — new iteration state |
| 8 | 9 | Transcript encoding regression test | Medium | 3 h | Sonnet 4.6 | None — tests only |
| 9 | 3 | Streaming | High | 2 days | Sonnet 4.6 | Medium — changes core loop |
| 10 | 1 | Context window management | High | 3 days | Opus 4.7 | High — novel territory, edge cases |

### Rationale for high-complexity items

**§3 Streaming (Sonnet 4.6, 2 days).** The pattern is well-understood but the execution surface is wide. Tool call delta accumulation across partial JSON chunks is fiddly; the mock infrastructure in `execute.test.ts` needs to produce `AsyncIterable` completions; the fallback path for non-streaming providers adds a second code path to maintain. No novel design decisions, but high test burden and plenty of surface for subtle bugs.

**§1 Context management (Opus 4.7, 3 days).** This is the only item that requires genuine architectural judgment under uncertainty. The compaction call can itself fail or produce output that is still too large; the threshold calibration is model-dependent and not discoverable at runtime; the interaction between compaction and stall detection (§6) needs thought. The spec above is intentionally incomplete on these edge cases — they require reasoned decisions, not just execution.

### Batching

**Batch A — quick wins** (§10, §7, §5, §8, §2): ~4.5 hours total, all Haiku 4.5. Mechanical, well-specified, isolated. Single PR, low review burden.

**Batch B — medium complexity** (§4, §6, §9): ~9 hours total, Sonnet 4.6. These interact lightly (§9 tests infrastructure that §4 and §6 extend), so sequential is safer than parallel.

**Batch C — streaming** (§3): 2 days, Sonnet 4.6. Should precede context management so the compaction call is visible in the transcript as it happens.

**Batch D — context management** (§1): 3 days, Opus 4.7. Goes last; depends on streaming being in place for full observability.

**Total: ~6.5 days across four PRs.** Batches A and B can run in parallel with each other. C must precede D. If streaming is deprioritised, A + B + D can proceed in order — compaction will emit non-streaming entries for the summary call, which is acceptable for a first cut.

---

## Out of scope

- **Model context window discovery.** Fetching `context_length` from the OpenRouter model listing to set `compactionThreshold` automatically is valuable but adds an external dependency to the startup path. Deferred to a subsequent phase.
- **Field-level object pruning for large responses.** Pruning null fields and truncating arrays in API responses (§7 option B) requires domain knowledge of the Paperclip API shape. Better addressed as a field in `PaperclipApi` response types.
- **Multi-provider fallback.** If the configured model is unavailable, fall back to an alternate. Out of scope; this belongs in an orchestration layer above the adapter.
- **Shared `ToolResultError` in `adapter-utils`.** Only relevant once another adapter needs the same pattern.

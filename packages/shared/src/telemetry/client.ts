import { createHash } from "node:crypto";
import type {
  TelemetryConfig,
  TelemetryDimensions,
  TelemetryEvent,
  TelemetryEventDimensions,
  TelemetryEventEnvelope,
  TelemetryEventName,
  TelemetryState,
} from "./types.js";
import { type ResolvedTelemetryCaps, resolveCaps } from "./config.js";
import { PAPERCLIP_EVENTS } from "./generated/paperclip-telemetry.js";

const DEFAULT_ENDPOINTS = [
  "https://telemetry.paperclip.ing/ingest",
  "https://rusqrrg391.execute-api.us-east-1.amazonaws.com/ingest",
] as const;
// Queue-pressure valve: auto-flush once this many events are buffered. This is
// an in-memory backpressure trigger, independent of the wire caps that
// `chunkForSend` enforces on each POST.
const BATCH_SIZE = 50;
const SEND_TIMEOUT_MS = 5_000;

/**
 * Deterministic, key-stable JSON serialization used to derive a content-stable
 * `batchId`. Object keys are sorted so two structurally-equal event sets always
 * produce the same string regardless of insertion order. Mirrors the
 * `stableStringify` exemplar in `external-objects-server.ts`.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Parses a `Retry-After` header into milliseconds — defensively, only when
 * present and a non-negative number of seconds. The telemetry backend emits no
 * `Retry-After` today, so this never fires in practice; it exists so a future
 * server hint is honored rather than ignored. The HTTP-date form is
 * intentionally not parsed.
 */
function parseRetryAfterMs(response: { headers?: { get?(name: string): string | null } }): number | undefined {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

type TrackArgs<K extends TelemetryEventName> =
  keyof TelemetryEventDimensions<K> extends never
    ? [dimensions?: TelemetryEventDimensions<K>]
    : [dimensions: TelemetryEventDimensions<K>];

// Length of the truncated hex `batchId`. 32 hex chars = 128 bits — the
// collision-safe floor. Do not lower below 32.
const BATCH_ID_HEX_LENGTH = 32;

/**
 * A chunk awaiting retry. `events` + `batchId` are frozen at first send and
 * re-sent verbatim on every attempt — re-mixing events would change the content
 * the server hashed under this id and trigger a 409. `attempt` is 1-based (the
 * value of the attempt about to be made); `nextAttemptAt` is an epoch-ms gate.
 * `timerId` is this batch's scheduled retry wake-up (if any) — held on the record
 * so it can be cancelled when the batch is evicted from the bounded store,
 * otherwise the timer would keep firing for a batch that no longer exists.
 */
interface PendingBatch {
  events: TelemetryEvent[];
  batchId: string;
  attempt: number;
  nextAttemptAt: number;
  timerId?: ReturnType<typeof setTimeout>;
}

export class TelemetryClient {
  private queue: TelemetryEvent[] = [];
  private readonly config: TelemetryConfig;
  private readonly caps: ResolvedTelemetryCaps;
  private readonly stateFactory: () => TelemetryState;
  private readonly version: string;
  private readonly random: () => number;
  private state: TelemetryState | null = null;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  // In-memory pending-retry store (best-effort; never persisted). Bounded by
  // `maxPendingRetryBatches`. Insertion order == age (oldest at the front).
  private pending: PendingBatch[] = [];
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    config: TelemetryConfig,
    stateFactory: () => TelemetryState,
    version: string,
    // Injectable RNG for backoff jitter — defaults to `Math.random`; tests pass
    // a seeded function for deterministic backoff. Callers keep the 3-arg form.
    random: () => number = Math.random,
  ) {
    this.config = config;
    this.caps = resolveCaps(config);
    this.stateFactory = stateFactory;
    this.version = version;
    this.random = random;
  }

  /**
   * Tracks first-party Paperclip telemetry events registered in the generated
   * backend event schema.
   */
  track<K extends TelemetryEventName>(eventName: K, ...args: TrackArgs<K>): void {
    if (!Object.hasOwn(PAPERCLIP_EVENTS, eventName)) return;
    const [dimensions] = args;
    this.enqueue(eventName, dimensions);
  }

  /**
   * Tracks plugin telemetry bridge events whose names are built dynamically
   * from third-party plugin input. The backend accepts only explicitly
   * registered plugin events.
   */
  trackDynamic(eventName: string, dimensions?: TelemetryDimensions): void {
    this.enqueue(eventName, dimensions);
  }

  private enqueue(eventName: string, dimensions?: object): void {
    if (!this.config.enabled) return;
    this.getState(); // ensure state is initialised (side-effect: creates state file on first call)

    this.queue.push({
      name: eventName,
      occurredAt: new Date().toISOString(),
      dimensions: { ...dimensions } as TelemetryDimensions,
    });

    if (this.queue.length >= BATCH_SIZE) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.config.enabled) return;

    // Re-send any due retries first, then send freshly-queued events.
    await this.drainPending();
    if (this.queue.length === 0) return;

    const events = this.queue.splice(0);
    for (const chunk of this.chunkForSend(events)) {
      await this.attemptSend({
        events: chunk,
        batchId: this.deriveBatchId(this.getState().installId, chunk),
        attempt: 1,
        nextAttemptAt: 0,
      });
    }
  }

  /**
   * Partitions a drained event list into wire-compliant chunks: first by
   * `maxEventsPerBatch` (count), then recursively byte-splits any chunk whose
   * serialized envelope still exceeds `maxBodyBytes` (halving). A single event
   * that alone exceeds `maxBodyBytes` is dropped-and-logged (fail loudly) rather
   * than sent over-limit.
   */
  private chunkForSend(events: TelemetryEvent[]): TelemetryEvent[][] {
    const maxCount = Math.max(1, this.caps.maxEventsPerBatch);
    const out: TelemetryEvent[][] = [];
    for (let i = 0; i < events.length; i += maxCount) {
      this.splitByBytes(events.slice(i, i + maxCount), out);
    }
    return out;
  }

  private splitByBytes(chunk: TelemetryEvent[], out: TelemetryEvent[][]): void {
    if (chunk.length === 0) return;
    const bytes = this.serializedBytes(this.buildEnvelope(chunk));
    if (bytes <= this.caps.maxBodyBytes) {
      out.push(chunk);
      return;
    }
    if (chunk.length === 1) {
      this.warn(
        Number.isFinite(bytes)
          ? `dropping 1 event whose serialized envelope exceeds maxBodyBytes (${this.caps.maxBodyBytes} bytes); event="${chunk[0]?.name}"`
          : `dropping 1 event with a non-serializable dimension (circular reference?); event="${chunk[0]?.name}"`,
      );
      return;
    }
    const mid = Math.ceil(chunk.length / 2);
    this.splitByBytes(chunk.slice(0, mid), out);
    this.splitByBytes(chunk.slice(mid), out);
  }

  private buildEnvelope(events: TelemetryEvent[], batchId?: string): TelemetryEventEnvelope {
    const state = this.getState();
    return {
      app: this.config.app ?? "paperclip",
      schemaVersion: this.config.schemaVersion ?? "1",
      installId: state.installId,
      version: this.version,
      events,
      batchId: batchId ?? this.deriveBatchId(state.installId, events),
    };
  }

  /**
   * Deterministic, salt-free content-hash idempotency key. Hashes
   * `{installId, events}` (scopes the key per install, matching the
   * server's `contentSha256` scope so cross-install batches never collide on the
   * server ledger key) and truncates to 128 bits. Identical input always
   * yields the same id, so a retried batch replays idempotently (202) instead of
   * double-counting; different events/install yield a different id.
   */
  private deriveBatchId(installId: string, events: TelemetryEvent[]): string {
    try {
      return createHash("sha256")
        .update(stableStringify({ installId, events }))
        .digest("hex")
        .slice(0, BATCH_ID_HEX_LENGTH);
    } catch {
      // A plugin can pass a circular (or otherwise non-serializable) `dimensions`
      // object via `trackDynamic`; `stableStringify` would then recurse until it
      // throws a `RangeError`. Fall back to a count-based hash so this call never
      // crashes the flush. Such an event can't be JSON-serialized for the wire
      // either, so it is dropped-and-logged in `splitByBytes` — this fallback id
      // is only ever attached to a batch that is about to be dropped, so its
      // weakened idempotency is moot. The single operator-facing signal is the
      // drop-and-log warning, not a (recursively-repeated) warning here.
      return createHash("sha256")
        .update(JSON.stringify({ installId, count: events.length }))
        .digest("hex")
        .slice(0, BATCH_ID_HEX_LENGTH);
    }
  }

  private serializedBytes(envelope: TelemetryEventEnvelope): number {
    try {
      return Buffer.byteLength(JSON.stringify(envelope));
    } catch {
      // A non-serializable event (e.g. a circular `dimensions` object from a
      // plugin) can neither be byte-measured nor sent over the wire. Report it
      // as effectively unbounded so `splitByBytes` routes it to the existing
      // over-limit drop-and-log path instead of throwing out of the flush.
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Sends one batch (its current `attempt`). On a retryable failure the EXACT
   * same events + `batchId` are re-queued with capped, jittered backoff; on a
   * terminal failure or after `maxAttempts` the batch is dropped-and-logged.
   */
  private async attemptSend(batch: PendingBatch): Promise<void> {
    const body = JSON.stringify(this.buildEnvelope(batch.events, batch.batchId));
    const outcome = this.classifyOutcome(await this.postEnvelope(body));

    if (outcome.kind === "ok") return;

    if (outcome.kind === "terminal") {
      this.warn(
        `dropping batch ${batch.batchId} on terminal response (HTTP ${outcome.status}); ${batch.events.length} event(s) lost`,
      );
      return;
    }

    // Retryable (429/502/503/504 or network/timeout).
    if (batch.attempt >= this.caps.backoff.maxAttempts) {
      this.warn(
        `dropping batch ${batch.batchId} after ${batch.attempt} attempt(s); ${batch.events.length} event(s) lost`,
      );
      return;
    }
    // Cap the delay at maxDelayMs. `computeBackoffMs` is already capped, but a
    // server `Retry-After` hint is not — an out-of-range value could otherwise
    // overflow the runtime timer range and be clamped by Node to a near-immediate
    // timeout, causing rapid retries. The cap keeps every retry within the
    // configured backoff ceiling.
    const delayMs = Math.min(
      outcome.retryAfterMs ?? this.computeBackoffMs(batch.attempt),
      this.caps.backoff.maxDelayMs,
    );
    this.enqueuePending({
      events: batch.events,
      batchId: batch.batchId,
      attempt: batch.attempt + 1,
      nextAttemptAt: Date.now() + delayMs,
    });
  }

  private classifyOutcome(
    result: { kind: "ok" } | { kind: "status"; status: number; retryAfterMs?: number } | { kind: "network" },
  ): { kind: "ok" } | { kind: "retry"; retryAfterMs?: number } | { kind: "terminal"; status: number } {
    if (result.kind === "ok") return { kind: "ok" };
    if (result.kind === "network") return { kind: "retry" };
    if (this.isRetryableStatus(result.status)) {
      return { kind: "retry", retryAfterMs: result.retryAfterMs };
    }
    return { kind: "terminal", status: result.status };
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  /**
   * Capped exponential backoff with symmetric jitter:
   * `min(maxDelayMs, baseDelayMs * 2^(attempt-1)) * (1 ± jitterRatio)`, using the
   * injected RNG. `attempt` is the failed attempt (1-based).
   */
  private computeBackoffMs(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitterRatio } = this.caps.backoff;
    const base = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const jitter = base * jitterRatio * (this.random() * 2 - 1);
    return Math.max(0, Math.min(maxDelayMs, Math.round(base + jitter)));
  }

  /**
   * Pushes a batch onto the pending store (bounded), then schedules its retry
   * wake-up. On overflow the OLDEST batches (front) are evicted first — newest
   * prioritized — and each eviction is logged so no batch is lost silently.
   */
  private enqueuePending(batch: PendingBatch): void {
    this.pending.push(batch);
    const bound = Math.max(0, this.caps.maxPendingRetryBatches);
    while (this.pending.length > bound) {
      const evicted = this.pending.shift();
      // Cancel the evicted batch's scheduled retry so its timer doesn't keep the
      // wake-up alive for a batch that is no longer in the store. Without this a
      // flush that overflows the bound would strand one live timer per evicted
      // batch even though `pending` itself stays bounded.
      if (evicted) this.cancelRetryTimer(evicted);
      this.warn(
        `pending-retry store full (bound=${bound}); evicted oldest batch ${evicted?.batchId}; ${evicted?.events.length ?? 0} event(s) lost`,
      );
    }
    // Only schedule a wake-up if this batch actually survived eviction. When the
    // batch is immediately evicted by the bound (e.g. a large failed flush, or
    // `maxPendingRetryBatches: 0`) it has no pending work, so scheduling a timer
    // for it would strand thousands of no-op timers behind a small bound.
    if (this.pending.includes(batch)) {
      this.scheduleDrain(batch);
    }
  }

  /** Cancels a pending batch's scheduled retry wake-up, if it has one. */
  private cancelRetryTimer(batch: PendingBatch): void {
    if (batch.timerId === undefined) return;
    clearTimeout(batch.timerId);
    this.retryTimers.delete(batch.timerId);
    batch.timerId = undefined;
  }

  private scheduleDrain(batch: PendingBatch): void {
    const delay = Math.max(0, batch.nextAttemptAt - Date.now());
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      batch.timerId = undefined;
      void this.drainPending();
    }, delay);
    // Don't keep the process alive for a best-effort retry (CLI exits promptly).
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref(): void }).unref();
    }
    this.retryTimers.add(timer);
    batch.timerId = timer;
  }

  /** Re-sends every pending batch whose `nextAttemptAt` is due. */
  private async drainPending(): Promise<void> {
    if (this.pending.length === 0) return;
    const now = Date.now();
    const due: PendingBatch[] = [];
    const waiting: PendingBatch[] = [];
    for (const batch of this.pending) {
      (batch.nextAttemptAt <= now ? due : waiting).push(batch);
    }
    this.pending = waiting;
    for (const batch of due) {
      await this.attemptSend(batch);
    }
  }

  /**
   * POSTs a serialized envelope, trying each endpoint in order. Returns the
   * definitive outcome: `ok` on a 2xx; the HTTP `status` on a definitive non-2xx
   * response (4xx incl. 429, which the shared API gateway fronts for every
   * endpoint, so it is authoritative — stop here); or `network` when every
   * endpoint threw. A transient upstream 5xx (502/503/504) does NOT stop the
   * loop: a sibling endpoint may be healthy, so we fall through to it and only
   * surface the last transient status if every endpoint returns one — matching
   * the pre-retry loop's endpoint-fallback behavior.
   */
  private async postEnvelope(
    body: string,
  ): Promise<{ kind: "ok" } | { kind: "status"; status: number; retryAfterMs?: number } | { kind: "network" }> {
    const endpoints = this.resolveEndpoints();
    let lastTransient: { kind: "status"; status: number; retryAfterMs?: number } | undefined;
    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (response.ok) return { kind: "ok" };
        const status = { kind: "status" as const, status: response.status, retryAfterMs: parseRetryAfterMs(response) };
        // Transient upstream 5xx: remember it and try the next endpoint.
        if (this.isTransientServerStatus(response.status)) {
          lastTransient = status;
          continue;
        }
        return status;
      } catch {
        // Network/timeout on this endpoint — try the next built-in endpoint.
      } finally {
        clearTimeout(timer);
      }
    }
    // Every endpoint failed: surface the last transient status (still retryable)
    // if we saw one, otherwise report a pure network failure.
    return lastTransient ?? { kind: "network" };
  }

  /** Upstream 5xx that a healthy sibling endpoint may still be able to serve. */
  private isTransientServerStatus(status: number): boolean {
    return status === 502 || status === 503 || status === 504;
  }

  private warn(message: string): void {
    console.warn(`[telemetry] ${message}`);
  }

  startPeriodicFlush(intervalMs: number = 60_000): void {
    if (this.flushInterval) return;
    this.flushInterval = setInterval(() => {
      void this.flush();
    }, intervalMs);
    // Allow the process to exit even if the interval is still active
    if (typeof this.flushInterval === "object" && "unref" in this.flushInterval) {
      this.flushInterval.unref();
    }
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  hashPrivateRef(value: string): string {
    const state = this.getState();
    return createHash("sha256")
      .update(state.salt + value)
      .digest("hex")
      .slice(0, 16);
  }

  private getState(): TelemetryState {
    if (!this.state) {
      this.state = this.stateFactory();
    }
    return this.state;
  }

  private resolveEndpoints(): readonly string[] {
    const configured = this.config.endpoint?.trim();
    return configured ? [configured] : DEFAULT_ENDPOINTS;
  }
}

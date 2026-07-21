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
// collision-safe floor mandated by the Stage-1 security review (C2). Do not
// lower below 32.
const BATCH_ID_HEX_LENGTH = 32;

export class TelemetryClient {
  private queue: TelemetryEvent[] = [];
  private readonly config: TelemetryConfig;
  private readonly caps: ResolvedTelemetryCaps;
  private readonly stateFactory: () => TelemetryState;
  private readonly version: string;
  private readonly random: () => number;
  private state: TelemetryState | null = null;
  private flushInterval: ReturnType<typeof setInterval> | null = null;

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
    if (!this.config.enabled || this.queue.length === 0) return;

    const events = this.queue.splice(0);
    for (const chunk of this.chunkForSend(events)) {
      await this.sendChunk(chunk);
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
    if (this.serializedBytes(this.buildEnvelope(chunk)) <= this.caps.maxBodyBytes) {
      out.push(chunk);
      return;
    }
    if (chunk.length === 1) {
      this.warn(
        `dropping 1 event whose serialized envelope exceeds maxBodyBytes (${this.caps.maxBodyBytes} bytes); event="${chunk[0]?.name}"`,
      );
      return;
    }
    const mid = Math.ceil(chunk.length / 2);
    this.splitByBytes(chunk.slice(0, mid), out);
    this.splitByBytes(chunk.slice(mid), out);
  }

  private buildEnvelope(events: TelemetryEvent[]): TelemetryEventEnvelope {
    const state = this.getState();
    return {
      app: this.config.app ?? "paperclip",
      schemaVersion: this.config.schemaVersion ?? "1",
      installId: state.installId,
      version: this.version,
      events,
      batchId: this.deriveBatchId(state.installId, events),
    };
  }

  /**
   * Deterministic, salt-free content-hash idempotency key. Hashes
   * `{installId, events}` (C1 — scopes the key per install, matching the
   * server's `contentSha256` scope so cross-install batches never collide on the
   * server ledger key) and truncates to 128 bits (C2). Identical input always
   * yields the same id, so a retried batch replays idempotently (202) instead of
   * double-counting; different events/install yield a different id.
   */
  private deriveBatchId(installId: string, events: TelemetryEvent[]): string {
    return createHash("sha256")
      .update(stableStringify({ installId, events }))
      .digest("hex")
      .slice(0, BATCH_ID_HEX_LENGTH);
  }

  private serializedBytes(envelope: TelemetryEventEnvelope): number {
    return Buffer.byteLength(JSON.stringify(envelope));
  }

  /** POSTs one already-built chunk; drops on any non-OK/error (best-effort). */
  private async sendChunk(events: TelemetryEvent[]): Promise<void> {
    await this.postEnvelope(JSON.stringify(this.buildEnvelope(events)));
  }

  /**
   * POSTs a serialized envelope, trying each endpoint in order. Returns the
   * definitive outcome: `ok` on a 2xx, the HTTP `status` on a non-2xx response
   * (no endpoint fallback — the endpoints front the same backend, so a real
   * status is authoritative), or `network` when every endpoint threw.
   */
  private async postEnvelope(
    body: string,
  ): Promise<{ kind: "ok" } | { kind: "status"; status: number; retryAfterMs?: number } | { kind: "network" }> {
    const endpoints = this.resolveEndpoints();
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
        return { kind: "status", status: response.status, retryAfterMs: parseRetryAfterMs(response) };
      } catch {
        // Network/timeout on this endpoint — try the next built-in endpoint.
      } finally {
        clearTimeout(timer);
      }
    }
    return { kind: "network" };
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

import type { TelemetryConfig, TelemetryDimensions, TelemetryEvent, TelemetryEventName, TelemetryState } from "../types.js";

const DEFAULT_ENDPOINTS = [
  "https://telemetry.paperclip.ing/ingest",
  "https://rusqrrg391.execute-api.us-east-1.amazonaws.com/ingest",
] as const;
const BATCH_SIZE = 50;
const SEND_TIMEOUT_MS = 5_000;

export class BrowserTelemetryClient {
  private queue: TelemetryEvent[] = [];
  private readonly config: TelemetryConfig;
  private readonly stateFactory: () => TelemetryState;
  private readonly statePersister: ((state: TelemetryState) => void) | null;
  private readonly version: string;
  private state: TelemetryState | null = null;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private context: TelemetryDimensions = {};

  constructor(
    config: TelemetryConfig,
    stateFactory: () => TelemetryState,
    version: string,
    statePersister?: (state: TelemetryState) => void,
  ) {
    this.config = config;
    this.stateFactory = stateFactory;
    this.version = version;
    this.statePersister = statePersister ?? null;
  }

  setContext(dimensions: TelemetryDimensions): void {
    this.context = { ...this.context, ...dimensions };
  }

  track(eventName: TelemetryEventName, dimensions?: TelemetryDimensions): void {
    if (!this.config.enabled) return;
    const state = this.getState();
    this.markEventSeen(state, eventName);

    this.queue.push({
      name: eventName,
      occurredAt: new Date().toISOString(),
      dimensions: { ...this.context, ...(dimensions ?? {}) },
    });

    if (this.queue.length >= BATCH_SIZE) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || this.queue.length === 0) return;

    const events = this.queue.splice(0);
    const state = this.getState();
    const endpoints = this.resolveEndpoints();
    const app = this.config.app ?? "paperclip-ui";
    const schemaVersion = this.config.schemaVersion ?? "1";
    const body = JSON.stringify({
      app,
      schemaVersion,
      installId: state.installId,
      version: this.version,
      events,
    });

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
        if (response.ok) {
          return;
        }
      } catch {
        // Try the next endpoint before dropping the batch
      } finally {
        clearTimeout(timer);
      }
    }
  }

  startPeriodicFlush(intervalMs: number = 60_000): void {
    if (this.flushInterval) return;
    this.flushInterval = setInterval(() => {
      void this.flush();
    }, intervalMs);
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  /** Hash a private reference using SubtleCrypto (browser-native, async). */
  async hashPrivateRef(value: string): Promise<string> {
    const state = this.getState();
    const encoder = new TextEncoder();
    const data = encoder.encode(state.salt + value);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  }

  hasTrackedEventName(eventName: TelemetryEventName): boolean {
    return this.getSeenEventNames().has(eventName);
  }

  private getState(): TelemetryState {
    if (!this.state) {
      this.state = this.stateFactory();
    }
    return this.state;
  }

  private getSeenEventNames(): Set<string> {
    return new Set(this.getState().seenEventNames ?? []);
  }

  private markEventSeen(state: TelemetryState, eventName: TelemetryEventName): void {
    const seen = new Set(state.seenEventNames ?? []);
    if (seen.has(eventName)) return;
    state.seenEventNames = [...seen, eventName].sort();
    this.statePersister?.(state);
  }

  private resolveEndpoints(): readonly string[] {
    const configured = this.config.endpoint?.trim();
    return configured ? [configured] : DEFAULT_ENDPOINTS;
  }
}

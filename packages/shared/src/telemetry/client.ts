import { createHash } from "node:crypto";
import type {
  TelemetryConfig,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryState,
} from "./types.js";

const DEFAULT_ENDPOINTS = [
  "https://telemetry.paperclip.ing/ingest",
  "https://rusqrrg391.execute-api.us-east-1.amazonaws.com/ingest",
] as const;
const BATCH_SIZE = 50;
const SEND_TIMEOUT_MS = 5_000;

export class TelemetryClient {
  private queue: TelemetryEvent[] = [];
  private readonly config: TelemetryConfig;
  private readonly stateFactory: () => TelemetryState;
  private readonly version: string;
  private state: TelemetryState | null = null;
  private flushInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: TelemetryConfig, stateFactory: () => TelemetryState, version: string) {
    this.config = config;
    this.stateFactory = stateFactory;
    this.version = version;
  }

  track(eventName: TelemetryEventName, dimensions?: Record<string, string | number | boolean>): void {
    if (!this.config.enabled) return;
    this.getState(); // ensure state is initialised (side-effect: creates state file on first call)

    this.queue.push({
      name: eventName,
      occurredAt: new Date().toISOString(),
      dimensions: dimensions ?? {},
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
    const app = this.config.app ?? "paperclip";
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
        // Try the next built-in endpoint before dropping the batch.
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

import type {
  TelemetryConfig,
  TelemetryDimensions,
  TelemetryEventDimensions,
  TelemetryEventName,
  TelemetryState,
} from "./types.js";

type TrackArgs<K extends TelemetryEventName> =
  keyof TelemetryEventDimensions<K> extends never
    ? [dimensions?: TelemetryEventDimensions<K>]
    : [dimensions: TelemetryEventDimensions<K>];

/**
 * Telemetry is permanently disabled. This client keeps the historical API
 * shape so existing call sites compile, but it never queues events, never
 * touches persistent state, never schedules timers, and never sends network
 * traffic. There is no supported way to re-enable it: the constructor forces
 * `enabled: false` even when a caller passes `enabled: true`.
 */
export class TelemetryClient {
  private readonly config: TelemetryConfig;
  private readonly stateFactory: () => TelemetryState;
  private readonly version: string;
  private readonly random: () => number;

  constructor(
    config: TelemetryConfig,
    stateFactory: () => TelemetryState,
    version: string,
    // Retained for signature compatibility; unused while disabled.
    random: () => number = Math.random,
  ) {
    // Force-disable even when a caller passes `enabled: true` so no
    // construction path can re-enable sending.
    this.config = { ...config, enabled: false, endpoint: undefined };
    this.stateFactory = stateFactory;
    this.version = version;
    this.random = random;
    void this.config;
    void this.stateFactory;
    void this.version;
    void this.random;
  }

  /**
   * Permanently disabled. Accepted for API compatibility but never queues,
   * persists state, or sends network traffic.
   */
  track<K extends TelemetryEventName>(eventName: K, ...args: TrackArgs<K>): void {
    void eventName;
    void args;
    return;
  }

  /**
   * Permanently disabled. Accepted for API compatibility but never queues,
   * persists state, or sends network traffic.
   */
  trackDynamic(eventName: string, dimensions?: TelemetryDimensions): void {
    void eventName;
    void dimensions;
    return;
  }

  async flush(): Promise<void> {
    // Permanently disabled: never send.
    return;
  }

  startPeriodicFlush(intervalMs: number = 60_000): void {
    void intervalMs;
    // Permanently disabled: never schedule flushes.
    return;
  }

  stop(): void {
    // Permanently disabled: nothing scheduled, nothing to clear.
    return;
  }

  hashPrivateRef(value: string): string {
    void value;
    // Permanently disabled: never touch state.
    return "";
  }
}

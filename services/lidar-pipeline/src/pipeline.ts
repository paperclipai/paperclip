import { EventEmitter } from "node:events";
import { parseLas } from "./ingestion.js";
import { normalizePoints } from "./normalization.js";
import { filterOutliers, type FilterOptions } from "./filter.js";
import { IngestionTracker, type IngestionTrackerOptions } from "./health.js";
import type {
  IngestionEvent,
  NormalizedPoint,
  HealthStatus,
} from "./types.js";

export interface PipelineOptions {
  filter?: FilterOptions;
  tracker?: IngestionTrackerOptions;
  /** Called after each successfully processed batch. */
  onBatch?: (sensorId: string, points: NormalizedPoint[]) => Promise<void> | void;
}

export interface PipelineEvents {
  batch: [sensorId: string, points: NormalizedPoint[]];
  error: [event: IngestionEvent, err: Error];
  health: [status: HealthStatus];
}

/**
 * LiDAR ingestion pipeline.
 *
 * Accepts IngestionEvents (from the RAWS-style queue), parses LAS/LAZ bytes,
 * normalises coordinates to WGS84, applies outlier filtering, and emits
 * normalised point batches. Mirrors the queue/event pattern used by the
 * RAWS data pipeline.
 */
export class LidarPipeline extends EventEmitter {
  private tracker: IngestionTracker;
  private opts: PipelineOptions;

  constructor(opts: PipelineOptions = {}) {
    super();
    this.opts = opts;
    this.tracker = new IngestionTracker(opts.tracker);
  }

  /**
   * Process a single ingestion event synchronously from the queue.
   * Errors are emitted as `error` events (not thrown) so the queue can
   * continue processing subsequent events.
   */
  async process(event: IngestionEvent): Promise<void> {
    try {
      if (event.format !== "las" && event.format !== "laz") {
        throw new Error(`Unsupported format: ${event.format}`);
      }

      // LAZ is LAS with optional compressed payload; the compressor is
      // expected to decompress before reaching this pipeline.  We accept
      // the same parsing path for both and surface a clear error if the
      // bytes are actually compressed.
      const raw = parseLas(event.payload, event.receivedAt);
      const normalized = normalizePoints(raw, event.sensorConfig);
      const filtered = filterOutliers(normalized, this.opts.filter);

      this.tracker.record(
        event.sensorConfig.sensorId,
        filtered.length,
      );

      this.emit("batch", event.sensorConfig.sensorId, filtered);

      if (this.opts.onBatch) {
        await this.opts.onBatch(event.sensorConfig.sensorId, filtered);
      }
    } catch (err) {
      this.emit("error", event, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Return current health metrics. */
  health(): HealthStatus {
    return this.tracker.getStatus();
  }
}

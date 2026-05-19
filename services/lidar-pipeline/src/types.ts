/** Raw point as read from a LAS/LAZ file in the sensor's native projection. */
export interface RawLidarPoint {
  /** X in projected CRS (e.g. UTM easting, metres) */
  x: number;
  /** Y in projected CRS (e.g. UTM northing, metres) */
  y: number;
  /** Z in metres above ellipsoid */
  z: number;
  intensity: number;
  /** LAS classification code (0–31) */
  classification: number;
  /** Unix epoch ms */
  timestamp: number;
  /** Return number within a single pulse */
  returnNumber: number;
  numberOfReturns: number;
  /** RGB color channels (uint16, 0–65535) — present for LAS formats 2, 3, 7, 8 */
  r?: number;
  g?: number;
  b?: number;
}

/** Point normalised to WGS84 / EPSG:4326 */
export interface NormalizedPoint {
  /** Decimal degrees, WGS84 */
  latitude: number;
  /** Decimal degrees, WGS84 */
  longitude: number;
  /** Metres above WGS84 ellipsoid */
  elevation: number;
  intensity: number;
  classification: number;
  timestamp: number;
  /** Return number within a single pulse (1-based) */
  returnNumber: number;
  /** Total number of returns for the pulse */
  numberOfReturns: number;
  /** RGB color channels (uint16, 0–65535) — present when source format includes color */
  r?: number;
  g?: number;
  b?: number;
}

/** Immutable sensor configuration attached to every ingestion event. */
export interface SensorConfig {
  sensorId: string;
  /** Human-readable location label, e.g. "Plot-A-NW-Tower" */
  location: string;
  /**
   * EPSG code of the sensor's native projected CRS.
   * e.g. 32610 = WGS84 / UTM zone 10N
   */
  sourceCrsEpsg: number;
  /**
   * UTM zone number (1–60) — required when sourceCrsEpsg is a UTM zone.
   * Ignored for non-UTM projections.
   */
  utmZone: number;
  /** 'N' | 'S' hemisphere for UTM */
  utmHemisphere: "N" | "S";
}

/** Single pipeline event carrying a batch of raw points. Mirrors the RAWS queue event shape. */
export interface IngestionEvent {
  eventId: string;
  sensorConfig: SensorConfig;
  format: "las" | "laz";
  /** Raw file bytes for LAS/LAZ parsing */
  payload: Buffer;
  receivedAt: number;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "no_data";
  activeSensors: number;
  lastSeenAt: number | null;
  /** Average ingestion rate over the last 60 s, points/sec */
  ingestionRate: number;
}

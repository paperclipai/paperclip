import type { RawLidarPoint, NormalizedPoint, SensorConfig } from "./types.js";

// WGS84 ellipsoid constants
const A = 6378137.0; // semi-major axis, metres
const F = 1 / 298.257223563; // flattening
const B = A * (1 - F); // semi-minor axis
const E2 = 2 * F - F * F; // eccentricity squared

const DEG = Math.PI / 180;

/**
 * Convert UTM easting/northing/elevation to WGS84 lat/lon/elevation.
 *
 * Implements the standard UTM → geographic conversion for WGS84 following
 * the formulas in USGS Professional Paper 1395 (Snyder 1987).
 */
export function utmToWgs84(
  easting: number,
  northing: number,
  elevationM: number,
  zone: number,
  hemisphere: "N" | "S",
): { latitude: number; longitude: number; elevation: number } {
  // False northing for southern hemisphere
  const trueNorthing = hemisphere === "S" ? northing - 10_000_000 : northing;
  const trueEasting = easting - 500_000;

  const k0 = 0.9996;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

  const M = trueNorthing / k0;
  const mu =
    M /
    (A *
      (1 -
        E2 / 4 -
        (3 * E2 * E2) / 64 -
        (5 * E2 * E2 * E2) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) *
      Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 * e1 * e1 * e1) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const N1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const T1 = tanPhi1 * tanPhi1;
  const C1 = (E2 / (1 - E2)) * cosPhi1 * cosPhi1;
  const R1 =
    (A * (1 - E2)) /
    Math.pow(1 - E2 * sinPhi1 * sinPhi1, 1.5);
  const D = trueEasting / (N1 * k0);

  const lat =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      (D * D / 2 -
        (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * (E2 / (1 - E2))) *
          (D * D * D * D) /
          24 +
        (61 +
          90 * T1 +
          298 * C1 +
          45 * T1 * T1 -
          252 * (E2 / (1 - E2)) -
          3 * C1 * C1) *
          (D * D * D * D * D * D) /
          720);

  const centralMeridian = (zone - 1) * 6 - 180 + 3;
  const lon =
    (D -
      (1 + 2 * T1 + C1) * (D * D * D) / 6 +
      (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * (E2 / (1 - E2)) + 24 * T1 * T1) *
        (D * D * D * D * D) /
        120) /
      cosPhi1 +
    centralMeridian * DEG;

  return {
    latitude: lat / DEG,
    longitude: lon / DEG,
    elevation: elevationM,
  };
}

/**
 * Normalize a batch of raw sensor points to WGS84 / EPSG:4326.
 * Only UTM source projections are supported in this release.
 */
export function normalizePoints(
  rawPoints: RawLidarPoint[],
  config: SensorConfig,
): NormalizedPoint[] {
  return rawPoints.map((p) => {
    const { latitude, longitude, elevation } = utmToWgs84(
      p.x,
      p.y,
      p.z,
      config.utmZone,
      config.utmHemisphere,
    );
    return {
      latitude,
      longitude,
      elevation,
      intensity: p.intensity,
      classification: p.classification,
      timestamp: p.timestamp,
      ...(p.r !== undefined && { r: p.r, g: p.g, b: p.b }),
    };
  });
}

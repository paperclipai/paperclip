import type { NormalizedPoint } from "./types.js";

export interface FilterOptions {
  /** Points with elevation more than this many SDs from the mean are removed. Default 3.0. */
  elevationZScoreThreshold?: number;
  /** Points with intensity outside [mean ± k*SD] are removed. Default 3.5. */
  intensityZScoreThreshold?: number;
}

interface Stats {
  mean: number;
  std: number;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Statistical outlier filter for LiDAR point clouds.
 *
 * Removes points whose elevation or intensity deviates more than k standard
 * deviations from the batch mean, then removes any points with invalid
 * (NaN/Infinite) coordinates. Classification code 7 (LAS "noise") is always
 * stripped regardless of thresholds.
 */
export function filterOutliers(
  points: NormalizedPoint[],
  opts: FilterOptions = {},
): NormalizedPoint[] {
  const elevK = opts.elevationZScoreThreshold ?? 3.0;
  const intK = opts.intensityZScoreThreshold ?? 3.5;

  // Strip LAS noise class and non-finite coordinates up front
  const valid = points.filter(
    (p) =>
      p.classification !== 7 &&
      isFinite(p.latitude) &&
      isFinite(p.longitude) &&
      isFinite(p.elevation),
  );

  if (valid.length === 0) return [];

  const elevStats = stats(valid.map((p) => p.elevation));
  const intStats = stats(valid.map((p) => p.intensity));

  return valid.filter((p) => {
    const elevZ =
      elevStats.std > 0
        ? Math.abs(p.elevation - elevStats.mean) / elevStats.std
        : 0;
    const intZ =
      intStats.std > 0
        ? Math.abs(p.intensity - intStats.mean) / intStats.std
        : 0;
    return elevZ <= elevK && intZ <= intK;
  });
}

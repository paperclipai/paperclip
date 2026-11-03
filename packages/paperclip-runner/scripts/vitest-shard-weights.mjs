// Weighted Vitest shards for the two PR Runner lanes. The native lane also runs
// the native server group, so it takes a smaller share of package files. Every
// lane orders the same inventory by path hash and takes one contiguous range,
// so the ranges stay disjoint and together cover every file exactly once.
import { createHash } from "node:crypto";

export const SHARD_WEIGHTS_ENV = "PAPERCLIP_RUNNER_VITEST_SHARD_WEIGHTS";

export function parseShardWeights(value, count) {
  if (value === undefined || value === "") return null;
  const weights = value.split(",").map((part) => Number(part.trim()));
  if (weights.length !== count || !weights.every((weight) => Number.isInteger(weight) && weight > 0)) {
    throw new Error(`${SHARD_WEIGHTS_ENV}=${value} must list ${count} positive integer weights`);
  }
  return weights;
}

export function weightedShardRange(fileCount, index, weights) {
  if (!Number.isInteger(index) || index < 1 || index > weights.length) {
    throw new Error(`Invalid shard index ${index} for ${weights.length} weighted shards`);
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const before = weights.slice(0, index - 1).reduce((sum, weight) => sum + weight, 0);
  const boundary = (weight) => Math.round((fileCount * weight) / total);
  return [boundary(before), boundary(before + weights[index - 1])];
}

export function weightedShard(files, pathOf, index, weights) {
  const [start, end] = weightedShardRange(files.length, index, weights);
  return files
    .map((file) => ({ file, hash: createHash("sha1").update(pathOf(file)).digest("hex") }))
    .sort((left, right) => (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0))
    .slice(start, end)
    .map(({ file }) => file);
}

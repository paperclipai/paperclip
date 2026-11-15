import { createHash } from "node:crypto";
import { K4_MIN_HOLD_MS } from "./types.js";

export function createRng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int(min: number, max: number) { return min + Math.floor(next() * (max - min + 1)); },
    hex(length: number) { let out = ""; while (out.length < length) out += Math.floor(next() * 16).toString(16); return out; },
    shuffle<T>(values: readonly T[]): T[] {
      const copy = [...values];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
      }
      return copy;
    },
  };
}

export const K4_HOLD_RANGE_MS: readonly [number, number] = [K4_MIN_HOLD_MS, 300_000];

export function k4HoldRange(maxMs?: number): readonly [number, number] {
  return maxMs === undefined ? K4_HOLD_RANGE_MS : [K4_HOLD_RANGE_MS[0], Math.max(K4_HOLD_RANGE_MS[0], maxMs)];
}

export function stableRequestId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 + (Number.parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

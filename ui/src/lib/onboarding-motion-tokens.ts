import tokenStyles from "../motion-tokens.css?raw";

// Use the same stylesheet as index.css for non-browser callers and before
// styles load. Do not maintain a second set of numeric defaults in JavaScript.
const defaults = new Map(
  [...tokenStyles.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
);
function token(name: string): string {
  const value = typeof document === "undefined"
    ? ""
    : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || defaults.get(name) || "";
}
export function motionNumber(name: string): number {
  return Number.parseFloat(token(name)) || 0;
}
export function motionMilliseconds(name: string): number {
  const value = token(name);
  return (Number.parseFloat(value) || 0) * (value.endsWith("ms") ? 1 : 1000);
}
export function motionSeconds(name: string): number {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  return motionMilliseconds(name) / 1000;
}
export function motionEase(name: string): [number, number, number, number] | "linear" {
  const match = token(name).match(/^cubic-bezier\(([^)]+)\)$/);
  const points = match?.[1].split(",").map(Number);
  return points?.length === 4 && points.every(Number.isFinite)
    ? points as [number, number, number, number]
    : "linear";
}

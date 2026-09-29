/** Process lifetimes use equality; retained small integers preserve old bytes. */
export type ProviderProcessGeneration = number | string;
export function isProviderProcessGeneration(value: unknown, allowZero = false): value is ProviderProcessGeneration {
  return (typeof value === "number" && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1))
    || (typeof value === "string" && /^p:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
}
export function isProviderGenerationSuccessor(previous: unknown, next: unknown): boolean {
  if (!isProviderProcessGeneration(previous, true) || !isProviderProcessGeneration(next)) return false;
  if (typeof previous === "number" && previous < Number.MAX_SAFE_INTEGER) return next === previous + 1;
  return typeof next === "string" && next !== previous;
}
/** Numeric successors are retained compatibility. An opaque successor must
 * carry the exact predecessor/startup binding committed by the native owner. */
export function provesProviderGenerationTransition(previous: unknown, next: unknown, value: unknown): boolean {
  if (!isProviderGenerationSuccessor(previous, next)) return false;
  if (typeof next === "number") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const transition = value as Record<string, unknown>;
  return Object.keys(transition).length === 3 && transition.from === previous && transition.to === next
    && typeof transition.launchId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transition.launchId);
}

/**
 * The first worker→host request that Core refused while one host→worker call
 * was in flight. A provider that lets such a refusal escape uncategorized
 * otherwise fails with no reason; the method name is Core's own registry
 * value, so it can be reported without passing provider text through.
 */
const refusedHostMethods = new WeakMap<object, string>();

export function recordRefusedHostMethod(error: object, method: string): void {
  refusedHostMethods.set(error, method);
}

/** The refused host method recorded on this call error, or null. */
export function readRefusedHostMethod(error: unknown): string | null {
  return error && typeof error === "object" ? refusedHostMethods.get(error) ?? null : null;
}

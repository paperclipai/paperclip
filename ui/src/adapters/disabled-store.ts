/**
 * Client-side store for disabled adapter types.
 *
 * Hydrated from the server's GET /api/adapters response.
 * Provides synchronous reads so module-level constants can filter against it.
 * Falls back to "nothing disabled" before the first hydration.
 *
 * Usage in components:
 *   useQuery + adaptersApi.list() populates the store automatically.
 *
 * Usage in non-React code:
 *   import { isAdapterTypeHidden } from "@/adapters/disabled-store";
 */

let disabledTypes = new Set<string>();

/** Check if an adapter type is hidden from menus (sync read). */
export function isAdapterTypeHidden(type: string): boolean {
  return disabledTypes.has(type);
}

/** Get all hidden adapter types (sync read). */
export function getHiddenAdapterTypes(): Set<string> {
  return disabledTypes;
}

/**
 * Hydrate the store from a server response.
 * Called by components that fetch the adapters list.
 */
export function setDisabledAdapterTypes(types: string[]): void {
  disabledTypes = new Set(types);
}

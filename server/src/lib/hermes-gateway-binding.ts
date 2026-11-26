import { isDeepStrictEqual } from "node:util";

const lifecycleFields = ["managedProfile", "apiBaseUrl", "expectedProfile", "apiKey", "token", "url", "paperclipApiUrl"] as const;

export function managedHermesConfigurationChanged(
  current: Record<string, unknown>, next: Record<string, unknown>,
): boolean {
  if (current.managedProfile !== true && next.managedProfile !== true) return false;
  return lifecycleFields.some(field => !isDeepStrictEqual(current[field], next[field]));
}

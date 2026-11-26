import { isDeepStrictEqual } from "node:util";

export function usesManagedHermesProfile(adapterType: string, config: Record<string, unknown>): boolean {
  return adapterType === "hermes_gateway" && config.managedProfile === true;
}

const lifecycleFields = ["managedProfile", "managedProfileAuthorizedBy", "apiBaseUrl", "expectedProfile", "apiKey", "token", "url", "paperclipApiUrl"] as const;

export function managedHermesConfigurationChanged(
  current: Record<string, unknown>, next: Record<string, unknown>,
): boolean {
  if (current.managedProfile !== true && next.managedProfile !== true) return false;
  return lifecycleFields.some(field => !isDeepStrictEqual(current[field], next[field]));
}

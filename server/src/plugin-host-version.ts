import { serverVersion } from "./version.js";

export function resolvePluginHostVersion(
  explicitVersion?: string,
  detectedVersion = serverVersion,
): string {
  return explicitVersion?.trim() || detectedVersion;
}

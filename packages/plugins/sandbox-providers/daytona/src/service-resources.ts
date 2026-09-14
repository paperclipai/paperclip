import type { Daytona, Resources, Sandbox } from "@daytonaio/sdk";

const fields = ["cpu", "memory", "disk", "gpu"] as const;
export class DaytonaServiceResourceConfigurationError extends Error {
  constructor() { super("The service resource allocation could not be verified against its configured sizes."); }
}
type ResourceField = (typeof fields)[number];
export function hasDaytonaServiceResourceRequest(config: Record<string, unknown>) {
  return fields.some((key) => config[key] !== undefined && config[key] !== null && config[key] !== "");
}

function requestedResources(config: Record<string, unknown>): Resources | null {
  const requested: Resources = {};
  for (const key of fields) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    // Operator resource settings are allocations, not hints. Do not truncate,
    // coerce malformed values, or silently substitute provider defaults.
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return null;
    requested[key] = value;
  }
  return requested;
}

export function daytonaServiceResourcesMatch(actual: Partial<Record<ResourceField, unknown>>, config: Record<string, unknown>) {
  const requested = requestedResources(config);
  if (!requested) return false;
  return fields.every((key) => requested[key] === undefined || actual[key] === requested[key]);
}

/** Read-only preflight. A named snapshot fixes its resource allocation; the
 * create-from-snapshot API has no resource overrides. Verify that allocation
 * instead of silently dropping the environment's configured resource sizes. */
export async function verifyDaytonaServiceResourceConfiguration(client: Pick<Daytona, "snapshot">, config: Record<string, unknown>) {
  if (!requestedResources(config)) return false;
  if (!hasDaytonaServiceResourceRequest(config)) return true;
  if (typeof config.image === "string" && config.image.trim()) return true;
  if (typeof config.snapshot !== "string" || !config.snapshot.trim()) return false;
  const snapshot = await client.snapshot.get(config.snapshot.trim());
  return daytonaServiceResourcesMatch({ cpu: snapshot.cpu, memory: snapshot.mem, disk: snapshot.disk, gpu: snapshot.gpu }, config);
}

export function verifyDaytonaServiceAllocationResources(sandbox: Sandbox, config: Record<string, unknown>) {
  return daytonaServiceResourcesMatch(sandbox, config);
}

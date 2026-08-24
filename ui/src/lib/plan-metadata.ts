import { planMetadataSchema } from "@paperclipai/shared";
import type { PlanMetadata } from "@paperclipai/shared";

/**
 * Safely parse raw planMetadata from the server.
 *
 * Returns the validated PlanMetadata when the data matches the expected shape,
 * or null when the data is absent or malformed. Invalid data is logged as a
 * warning instead of crashing the UI.
 */
export function parsePlanMetadata(raw: unknown): PlanMetadata | null {
  if (raw == null) return null;

  const result = planMetadataSchema.safeParse(raw);
  if (result.success) return result.data;

  console.warn(
    "[plan-metadata] Received invalid planMetadata from server; falling back to null. Validation issues:",
    result.error.issues,
  );
  return null;
}
import { z } from "zod";

/** Maximum length of an asset namespace, in characters. */
export const ASSET_NAMESPACE_MAX_LENGTH = 120;

/**
 * Characters that an asset namespace can contain.
 *
 * The set is wider than a plain slug because namespaces embed user ids. A
 * hosted deployment takes user ids from its identity layer without a change,
 * and an OIDC subject often contains ":", "|", "." or "@".
 */
const ASSET_NAMESPACE_PATTERN = /^[a-zA-Z0-9/_.:@|-]+$/;

/** Characters that a single namespace segment cannot contain. */
const DISALLOWED_SEGMENT_CHARS = /[^a-zA-Z0-9_.:@|-]+/g;

/** Human-readable statement of the namespace rule. Reused in API errors. */
export const ASSET_NAMESPACE_RULE = `"namespace" must be 1-${ASSET_NAMESPACE_MAX_LENGTH} characters of letters, numbers, or / _ - . : @ |, and cannot contain "." or ".." path segments`;

/** True when the segment is a relative path step, which is traversal. */
function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/**
 * True when the segment is safe to keep in a namespace.
 *
 * The schema and the sanitizer share `isDotSegment`, so the sanitizer never
 * drops a segment that the schema accepts. A segment of three or more dots is
 * an ordinary directory name, and it survives.
 */
function isUsableSegment(segment: string): boolean {
  return segment.length > 0 && !isDotSegment(segment);
}

function hasNoDotSegments(namespace: string): boolean {
  return !namespace.split("/").some(isDotSegment);
}

export const createAssetImageMetadataSchema = z.object({
  namespace: z
    .string()
    .trim()
    .min(1)
    .max(ASSET_NAMESPACE_MAX_LENGTH)
    .regex(ASSET_NAMESPACE_PATTERN, ASSET_NAMESPACE_RULE)
    .refine(hasNoDotSegments, { message: ASSET_NAMESPACE_RULE })
    .optional(),
});

export type CreateAssetImageMetadata = z.infer<typeof createAssetImageMetadataSchema>;

/**
 * Make a namespace that `createAssetImageMetadataSchema` accepts.
 *
 * Each "/"-separated segment keeps its accepted characters. Other characters
 * become "-", repeated dashes collapse, and empty, "." and ".." segments go
 * away. The result is at most `ASSET_NAMESPACE_MAX_LENGTH` characters.
 *
 * Returns undefined when no segment survives. Callers then send no namespace
 * and the server applies its default.
 */
export function sanitizeAssetNamespace(namespace: string): string | undefined {
  const cleaned = namespace
    .split("/")
    .map((segment) => segment.trim().replace(DISALLOWED_SEGMENT_CHARS, "-").replace(/-{2,}/g, "-"))
    .filter(isUsableSegment)
    .join("/");
  if (cleaned.length <= ASSET_NAMESPACE_MAX_LENGTH) {
    return cleaned.length > 0 ? cleaned : undefined;
  }

  // A cut can leave an empty, "." or ".." tail segment, so filter again.
  const truncated = cleaned
    .slice(0, ASSET_NAMESPACE_MAX_LENGTH)
    .split("/")
    .filter(isUsableSegment)
    .join("/");
  return truncated.length > 0 ? truncated : undefined;
}

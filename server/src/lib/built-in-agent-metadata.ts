export const BUILT_IN_AGENT_METADATA_KEY = "paperclipBuiltInAgent";

export interface BuiltInAgentMarker {
  key: string;
  featureKeys: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFeatureKeys(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const featureKeys = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return featureKeys.length === value.length ? featureKeys : null;
}

export function readBuiltInAgentMarker(metadata: unknown): BuiltInAgentMarker | null {
  if (!isPlainRecord(metadata)) return null;
  const marker = metadata[BUILT_IN_AGENT_METADATA_KEY];
  if (!isPlainRecord(marker)) return null;
  const key = marker.key;
  const featureKeys = normalizeFeatureKeys(marker.featureKeys);
  if (typeof key !== "string" || key.trim().length === 0 || !featureKeys) return null;
  return { key, featureKeys };
}

export function withBuiltInAgentMarker(
  metadata: Record<string, unknown> | null | undefined,
  marker: BuiltInAgentMarker,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [BUILT_IN_AGENT_METADATA_KEY]: {
      key: marker.key,
      featureKeys: [...marker.featureKeys],
    },
  };
}

export function builtInAgentMarkersEqual(left: BuiltInAgentMarker | null, right: BuiltInAgentMarker | null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.key === right.key && JSON.stringify(left.featureKeys) === JSON.stringify(right.featureKeys);
}

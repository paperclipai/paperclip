import type { HostFeatureKey, HostFeaturesSnapshotV1 } from "@paperclipai/shared";
import { HOST_FEATURE_KEYS } from "@paperclipai/shared";

export const EMPTY_RUNTIME_FEATURES: HostFeaturesSnapshotV1 = {
  schemaVersion: 1,
  hostFeatures: [],
};

/** Read the server-rendered feature snapshot before React mounts. */
export function readRuntimeFeaturesBootstrap(doc: Document = document): HostFeaturesSnapshotV1 {
  const element = doc.getElementById("paperclip-runtime-features");
  if (!element?.textContent) return EMPTY_RUNTIME_FEATURES;

  try {
    const parsed = JSON.parse(element.textContent) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.hostFeatures)) {
      return EMPTY_RUNTIME_FEATURES;
    }
    const allowed = new Set<string>(HOST_FEATURE_KEYS);
    const hostFeatures = parsed.hostFeatures.filter(
      (feature): feature is HostFeatureKey => typeof feature === "string" && allowed.has(feature),
    );
    if (hostFeatures.length !== parsed.hostFeatures.length || new Set(hostFeatures).size !== hostFeatures.length) {
      return EMPTY_RUNTIME_FEATURES;
    }
    return { schemaVersion: 1, hostFeatures };
  } catch {
    return EMPTY_RUNTIME_FEATURES;
  }
}

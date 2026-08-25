import type { Db } from "@paperclipai/db";
import type {
  HostFeatureKey,
  HostFeaturesSnapshotV1,
  PaperclipPluginManifestV1,
  PluginStatus,
} from "@paperclipai/shared";
import {
  HOST_FEATURE_KEYS,
  PAPERCLIP_EE_PLUGIN_ID,
  pluginManifestV1Schema,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { pluginRegistryService } from "./plugin-registry.js";

type HostFeatureProviderRecord = {
  pluginKey: string;
  status: PluginStatus;
  manifestJson: PaperclipPluginManifestV1;
};

const EMPTY_SNAPSHOT: HostFeaturesSnapshotV1 = Object.freeze({
  schemaVersion: 1,
  hostFeatures: [],
});

/**
 * Resolve a stored provider record without trusting its JSONB shape. Only a
 * ready canonical EE plugin with a currently valid declaration contributes.
 */
export function resolveHostFeaturesFromProvider(
  provider: HostFeatureProviderRecord | null | undefined,
): HostFeaturesSnapshotV1 {
  if (
    !provider
    || provider.pluginKey !== PAPERCLIP_EE_PLUGIN_ID
    || provider.status !== "ready"
  ) {
    return EMPTY_SNAPSHOT;
  }

  const parsed = pluginManifestV1Schema.safeParse(provider.manifestJson);
  if (!parsed.success || parsed.data.id !== PAPERCLIP_EE_PLUGIN_ID) {
    return EMPTY_SNAPSHOT;
  }

  const declared = new Set(parsed.data.hostFeatures?.features ?? []);
  return {
    schemaVersion: 1,
    hostFeatures: HOST_FEATURE_KEYS.filter((feature) => declared.has(feature)),
  };
}

/** Resolve the current instance-level host features from plugin lifecycle state. */
export async function resolveHostFeatures(db: Db): Promise<HostFeaturesSnapshotV1> {
  const provider = await pluginRegistryService(db).getByKey(PAPERCLIP_EE_PLUGIN_ID);
  return resolveHostFeaturesFromProvider(provider);
}

export async function hasHostFeature(db: Db, feature: HostFeatureKey): Promise<boolean> {
  return (await resolveHostFeatures(db)).hostFeatures.includes(feature);
}

/** Fail closed with the stable product-unavailable response used by HTTP gates. */
export async function requireHostFeature(db: Db, feature: HostFeatureKey): Promise<void> {
  if (await hasHostFeature(db, feature)) return;
  throw notFound("Feature unavailable", {
    code: "feature_unavailable",
    feature,
  });
}

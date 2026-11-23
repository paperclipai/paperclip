import { createHash } from "node:crypto";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
export interface IdlePluginCatalogEntry { pluginId: string; manifestGeneration: string }
export function pluginIdleManifestGeneration(manifest: PaperclipPluginManifestV1): string {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, ordered(v)])) : value;
  return createHash("sha256").update(JSON.stringify(ordered(manifest))).digest("hex");
}

import type { AdapterRegistryEntryParsed } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { listServerAdapters } from "../adapters/registry.js";
export { parseAdapterRegistryEnv, type AdapterRegistryEnv } from "./adapter-registry-config.js";

export function reconcileAdapterAvailability(
  registry: AdapterRegistryEntryParsed[] | null,
): { enabled: string[]; disabled: string[] } {
  if (!registry) return { enabled: [], disabled: [] };

  const knownTypes = new Set(listServerAdapters().map((a) => a.type));
  const declared = new Map(registry.map((e) => [e.adapterType, e]));

  const missing = [...declared.keys()].filter((t) => !knownTypes.has(t));
  if (missing.length > 0) {
    throw new Error(
      `PAPERCLIP_ADAPTERS declares adapter type(s) with no installed adapter: ${missing.join(", ")}`,
    );
  }

  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const type of knownTypes) {
    const entry = declared.get(type);
    const shouldEnable = entry !== undefined && entry.enabled !== false;
    (shouldEnable ? enabled : disabled).push(type);
  }

  logger.info({ enabled, disabled }, "validated adapter availability from PAPERCLIP_ADAPTERS");
  return { enabled, disabled };
}

/**
 * Declarative adapter-registry bootstrap.
 *
 * One source (`PAPERCLIP_ADAPTERS` inline JSON, or `PAPERCLIP_ADAPTERS_FILE` a
 * path to a JSON file) feeds two consumers:
 *   1. Availability: reconcile the file-backed disabled-set so the picker shows
 *      exactly the declared, enabled set (runs for any instance).
 *   2. k8s runtime: the same registry rides on the Kubernetes environment config
 *      (see execution-policy-bootstrap) so the plugin resolves runtime
 *      image/envKeys/allowFqdns/probe/defaultEnv from it.
 *
 * Parsing is pure + fails loud on malformed/invalid config, mirroring
 * execution-policy-bootstrap.
 */
import fs from "node:fs";
import { adapterRegistrySchema, type AdapterRegistryEntryParsed } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { listServerAdapters } from "../adapters/registry.js";
import { setAdapterDisabled } from "./adapter-plugin-store.js";

export type AdapterRegistryEnv = Record<string, string | undefined>;

/**
 * Parse the declarative registry from env. Returns null when unconfigured
 * (built-in defaults; local/OSS unchanged). Throws on malformed/invalid input.
 */
export function parseAdapterRegistryEnv(
  env: AdapterRegistryEnv = process.env,
): AdapterRegistryEntryParsed[] | null {
  const inline = env.PAPERCLIP_ADAPTERS?.trim();
  const filePath = env.PAPERCLIP_ADAPTERS_FILE?.trim();
  if (!inline && !filePath) return null;

  let rawText: string;
  if (inline) {
    rawText = inline;
  } else {
    try {
      rawText = fs.readFileSync(filePath as string, "utf-8");
    } catch (err) {
      throw new Error(
        `PAPERCLIP_ADAPTERS_FILE could not be read at "${filePath}": ${(err as Error).message}`,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`PAPERCLIP_ADAPTERS must be valid JSON: ${(err as Error).message}`);
  }

  const result = adapterRegistrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `PAPERCLIP_ADAPTERS failed validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Reconcile availability: every known server adapter NOT enabled in the declared
 * registry is disabled; declared+enabled ones are enabled. Throws if a declared
 * adapterType has no installed adapter (cannot offer a harness with no
 * implementation). No-op when `registry` is null.
 */
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
    setAdapterDisabled(type, !shouldEnable);
    (shouldEnable ? enabled : disabled).push(type);
  }

  logger.info({ enabled, disabled }, "reconciled adapter availability from PAPERCLIP_ADAPTERS");
  return { enabled, disabled };
}

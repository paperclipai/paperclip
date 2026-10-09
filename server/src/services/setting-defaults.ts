import {
  SETTING_DEFAULTS_ENV_KEY,
  parseSettingDefaults,
  type OperatorSettingDefaults,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export { SETTING_DEFAULTS_ENV_KEY };

export type SettingDefaultsEnv = Record<string, string | undefined>;

let cache: { raw: string | undefined; defaults: OperatorSettingDefaults | null } | null = null;

/**
 * Operator setting defaults from the `PAPERCLIP_SETTING_DEFAULTS` env var
 * (JSON object validated against the shared registry). Parse-once accessor
 * keyed on the raw value, mirroring settings-visibility.ts: tests passing a
 * custom env re-parse when the raw value differs; process.env callers share
 * one parse for the process lifetime.
 *
 * Unknown field names are warned about once and ignored (mixed-version fleet
 * safe). Malformed JSON or an invalid value for a known field throws — policy
 * configuration fails closed, and index.ts calls this at boot so the failure
 * is loud and immediate.
 */
export function getOperatorSettingDefaults(
  env: SettingDefaultsEnv = process.env,
): OperatorSettingDefaults | null {
  const raw = env[SETTING_DEFAULTS_ENV_KEY];
  if (cache && cache.raw === raw) return cache.defaults;
  const { defaults, unknown } = parseSettingDefaults(raw);
  if (unknown.length > 0) {
    logger.warn(
      { unknownKeys: unknown },
      `${SETTING_DEFAULTS_ENV_KEY} contains unknown fields; they are ignored`,
    );
  }
  cache = { raw, defaults };
  return cache.defaults;
}

import { parseHiddenSettingsList } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * Operator-hidden settings, from the `PAPERCLIP_HIDDEN_SETTINGS` env var
 * (comma-separated keys from the shared settings-visibility registry). Unknown
 * keys are warned about once and ignored so one list can be rolled across a
 * fleet of mixed app versions without refusing boot on older images.
 */
export const HIDDEN_SETTINGS_ENV_KEY = "PAPERCLIP_HIDDEN_SETTINGS";

export type HiddenSettingsEnv = Record<string, string | undefined>;

let cache: { raw: string | undefined; hidden: ReadonlySet<string> } | null = null;

/**
 * Parse-once accessor keyed on the raw env value. Callers that pass a custom
 * env (tests) get a fresh parse whenever the raw value differs; process.env
 * callers share one parsed set for the process lifetime. Members are always
 * `HideableSettingKey`s; typed as strings so route code can probe with
 * computed `instance.*` keys.
 */
export function getHiddenSettings(
  env: HiddenSettingsEnv = process.env,
): ReadonlySet<string> {
  const raw = env[HIDDEN_SETTINGS_ENV_KEY];
  if (cache && cache.raw === raw) return cache.hidden;
  const { hidden, unknown } = parseHiddenSettingsList(raw);
  if (unknown.length > 0) {
    logger.warn(
      { unknownKeys: unknown },
      `${HIDDEN_SETTINGS_ENV_KEY} contains unknown keys; they are ignored`,
    );
  }
  cache = { raw, hidden: new Set(hidden) };
  return cache.hidden;
}

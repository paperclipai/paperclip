import { experimentalSettingKey, INSTANCE_FEATURE_KEYS, parseHiddenSettingsList } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { isCloudStagingExperimentalSetting, isCloudStagingInstance } from "./cloud-instance.js";

/**
 * Operator-hidden settings, from the `PAPERCLIP_HIDDEN_SETTINGS` env var
 * (comma-separated keys from the shared settings-visibility registry). Unknown
 * keys are warned about once and ignored so one list can be rolled across a
 * fleet of mixed app versions without refusing boot on older images.
 */
export const HIDDEN_SETTINGS_ENV_KEY = "PAPERCLIP_HIDDEN_SETTINGS";

export type HiddenSettingsEnv = Record<string, string | undefined>;

let cache: { raw: string | undefined; staging: boolean; hidden: ReadonlySet<string> } | null = null;

export function getHiddenSettings(
  env: HiddenSettingsEnv = process.env,
): ReadonlySet<string> {
  const raw = env[HIDDEN_SETTINGS_ENV_KEY];
  const staging = isCloudStagingInstance(env);
  if (cache && cache.raw === raw && cache.staging === staging) return cache.hidden;
  const { hidden, unknown } = parseHiddenSettingsList(raw);
  if (unknown.length > 0) {
    logger.warn(
      { unknownKeys: unknown },
      `${HIDDEN_SETTINGS_ENV_KEY} contains unknown keys; they are ignored`,
    );
  }
  const visibleOnStaging = (key: string) =>
    key === "instance.experimental"
    || (key.startsWith("instance.experimental.") && isCloudStagingExperimentalSetting(key.slice("instance.experimental.".length)));
  const expanded = staging && hidden.includes("instance.experimental")
    ? [...hidden, ...INSTANCE_FEATURE_KEYS.map(experimentalSettingKey)]
    : hidden;
  cache = { raw, staging, hidden: new Set(staging ? expanded.filter((key) => !visibleOnStaging(key)) : hidden) };
  return cache.hidden;
}

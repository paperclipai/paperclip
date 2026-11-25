import { logger } from "../middleware/logger.js";

export const AVAILABLE_HARNESSES_ENV_KEY = "PAPERCLIP_AVAILABLE_HARNESSES";
const harnessId = /^[a-z][a-z0-9_:-]{0,127}$/;
let cache: { raw: string | undefined; available: string[] | undefined } | undefined;

/** Unset leaves existing choices intact; an empty array or invalid value allows none. */
export function getAvailableHarnesses(env: Record<string, string | undefined> = process.env): string[] | undefined {
  const raw = env[AVAILABLE_HARNESSES_ENV_KEY];
  if (cache && cache.raw === raw) return cache.available;
  let available: string[] | undefined;
  if (raw !== undefined) {
    let entries: unknown;
    try {
      entries = raw.length <= 16_384 ? JSON.parse(raw) : null;
    } catch {
      entries = null;
    }
    if (!Array.isArray(entries) || entries.length > 128 || entries.some((entry) => typeof entry !== "string" || !harnessId.test(entry))) {
      logger.warn(`${AVAILABLE_HARNESSES_ENV_KEY} is invalid; harness selection is disabled`);
      available = [];
    } else {
      available = [...new Set(entries)];
    }
  }
  cache = { raw, available };
  return available;
}

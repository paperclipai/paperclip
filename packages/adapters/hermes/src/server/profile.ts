const HERMES_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const DEFAULT_HERMES_PROFILE = "default";

export function validateHermesProfile(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return HERMES_PROFILE_PATTERN.test(value) ? value : null;
}

export function resolveHermesProfile(config: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(config, "profile")) {
    return DEFAULT_HERMES_PROFILE;
  }
  return validateHermesProfile(config.profile);
}

export const HERMES_PROFILE_INVALID_MESSAGE =
  "Invalid Hermes profile. Use 1-64 lowercase letters, numbers, hyphens, or underscores.";

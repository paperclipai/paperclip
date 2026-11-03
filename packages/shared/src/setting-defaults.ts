import { instanceGeneralSettingsSchema } from "./validators/instance.js";
import type { InstanceGeneralSettings } from "./types/instance.js";

/**
 * Operator-configurable setting defaults.
 *
 * A hosting operator (a managed cloud, an internal shared server) can replace
 * the schema default of selected instance settings by setting the
 * `PAPERCLIP_SETTING_DEFAULTS` environment variable to a JSON object, e.g.
 * `{"feedbackDataSharingPreference":"allowed"}`. The operator value
 * substitutes for the schema default at read time: any field whose effective
 * value is still the schema default resolves to the operator value, while an
 * explicit non-default user choice always wins. The overlay is never
 * persisted, so unsetting the variable restores stock behavior everywhere a
 * user has not chosen otherwise.
 *
 * Parsing is fail-closed for policy content: malformed JSON or an invalid
 * value for a known field is an error (the server refuses to boot), because a
 * silently dropped policy default is worse than a loud failure. Unknown field
 * names are warned about and ignored, so one value can be rolled across a
 * fleet of mixed app versions where older images predate a field.
 *
 * Pairing note: an operator that also wants the control invisible hides it
 * with `PAPERCLIP_HIDDEN_SETTINGS` (see settings-visibility.ts); the two
 * mechanisms are orthogonal.
 */

export const SETTING_DEFAULTS_ENV_KEY = "PAPERCLIP_SETTING_DEFAULTS";

/** Instance → General fields whose schema default an operator may replace. */
export const DEFAULTABLE_GENERAL_SETTINGS = [
  "feedbackDataSharingPreference",
] as const;

export type DefaultableGeneralSetting = (typeof DEFAULTABLE_GENERAL_SETTINGS)[number];

export type OperatorSettingDefaults = Partial<
  Pick<InstanceGeneralSettings, DefaultableGeneralSetting>
>;

export interface ParsedSettingDefaults {
  /** Validated operator defaults for known fields; null when the var is unset. */
  defaults: OperatorSettingDefaults | null;
  /** Unrecognized field names, for the caller to warn about. */
  unknown: string[];
}

const defaultableFieldsSchema = instanceGeneralSettingsSchema
  .pick(
    Object.fromEntries(DEFAULTABLE_GENERAL_SETTINGS.map((key) => [key, true])) as {
      [K in DefaultableGeneralSetting]: true;
    },
  )
  .partial();

/** The all-schema-defaults view used to decide whether a value was chosen. */
const schemaDefaults: InstanceGeneralSettings = instanceGeneralSettingsSchema.parse({});

/**
 * Parse a `PAPERCLIP_SETTING_DEFAULTS`-style JSON object.
 *
 * @throws when the JSON is malformed, not an object, or a known field carries
 * an invalid value — policy configuration fails closed.
 */
export function parseSettingDefaults(raw: string | undefined): ParsedSettingDefaults {
  if (raw === undefined || raw.trim() === "") return { defaults: null, unknown: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${SETTING_DEFAULTS_ENV_KEY} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SETTING_DEFAULTS_ENV_KEY} must be a JSON object of setting defaults`);
  }
  const known: Record<string, unknown> = {};
  const unknown: string[] = [];
  const defaultable = new Set<string>(DEFAULTABLE_GENERAL_SETTINGS);
  for (const [key, value] of Object.entries(parsed)) {
    if (defaultable.has(key)) {
      known[key] = value;
    } else {
      unknown.push(key);
    }
  }
  const result = defaultableFieldsSchema.safeParse(known);
  if (!result.success) {
    throw new Error(
      `${SETTING_DEFAULTS_ENV_KEY} carries an invalid value: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return { defaults: result.data as OperatorSettingDefaults, unknown };
}

/**
 * Overlay operator defaults onto normalized general settings at read time.
 *
 * The operator value substitutes for the schema default: a field still at its
 * schema default (absent from storage, or stored equal to it) resolves to the
 * operator value; an explicit non-default choice is untouched. Callers must
 * never persist the result.
 */
export function applyOperatorGeneralDefaults(
  general: InstanceGeneralSettings,
  defaults: OperatorSettingDefaults | null,
): InstanceGeneralSettings {
  if (!defaults) return general;
  let next: InstanceGeneralSettings | null = null;
  for (const key of DEFAULTABLE_GENERAL_SETTINGS) {
    const value = defaults[key];
    if (value === undefined) continue;
    if (general[key] === schemaDefaults[key] && general[key] !== value) {
      next ??= { ...general };
      next[key] = value;
    }
  }
  return next ?? general;
}

/**
 * Strip overlay echoes from a general-settings write at persist time.
 *
 * A client that writes back the full object it read (a full-GET echo) sends
 * the overlaid operator value for a field the user never chose. Persisting
 * that echo would promote the operator value into an explicit stored choice —
 * sticky across later changes to, or removal of, the environment variable.
 * This maps such a write back to the schema default: a field whose stored
 * value is still the schema default (unchosen) and whose incoming value
 * equals the operator default stays unchosen, keeping the overlay
 * strictly read-time.
 *
 * A user cannot be distinguished from an echo when they deliberately pick the
 * value that already shows as the default, so that pick also stays unchosen —
 * the mirror image of the documented "stored schema default is treated as
 * unchosen" rule, with identical effective behavior. Any other write persists
 * as given: an incoming value that differs from the operator default, or a
 * write over an explicit stored choice.
 */
export function stripOperatorGeneralEchoes(
  stored: InstanceGeneralSettings,
  next: InstanceGeneralSettings,
  defaults: OperatorSettingDefaults | null,
): InstanceGeneralSettings {
  if (!defaults) return next;
  let result: InstanceGeneralSettings | null = null;
  for (const key of DEFAULTABLE_GENERAL_SETTINGS) {
    const value = defaults[key];
    if (value === undefined) continue;
    if (
      stored[key] === schemaDefaults[key] &&
      next[key] === value &&
      next[key] !== schemaDefaults[key]
    ) {
      result ??= { ...next };
      result[key] = schemaDefaults[key];
    }
  }
  return result ?? next;
}

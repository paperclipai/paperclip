/**
 * @fileoverview Validates plugin instance configuration against its JSON Schema.
 *
 * Uses Ajv to validate `configJson` values against the `instanceConfigSchema`
 * declared in a plugin's manifest. This ensures that invalid configuration is
 * rejected at the API boundary, not discovered later at worker startup.
 *
 * @module server/services/plugin-config-validator
 */

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { JsonSchema } from "@paperclipai/shared";

/**
 * Keywords the plugin settings form (`ui/src/components/JsonSchemaForm.tsx`)
 * reads from `instanceConfigSchema`. They only change how the form looks, so
 * Ajv treats them as annotations. Keep this list in sync with the form.
 */
export const PLUGIN_CONFIG_FORM_KEYWORDS = [
  "x-paperclip-advanced",
  "x-paperclip-group",
  "x-paperclip-itemLabel",
  "x-paperclip-itemSummary",
] as const;

export interface ConfigValidationResult {
  valid: boolean;
  errors?: { field: string; message: string }[];
}

/**
 * Validate a config object against a JSON Schema.
 *
 * @param configJson - The configuration values to validate.
 * @param schema - The JSON Schema from the plugin manifest's `instanceConfigSchema`.
 * @returns Validation result with structured field errors on failure.
 */
export function validateInstanceConfig(
  configJson: Record<string, unknown>,
  schema: JsonSchema,
): ConfigValidationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  const ajv = new AjvCtor({ allErrors: true });
  // ajv-formats v3 default export is a FormatsPlugin object; call it as a plugin.
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  // Register the secret-ref format used by plugin manifests to mark fields that
  // hold a Paperclip secret UUID rather than a raw value. The format is a UI
  // hint only — UUID validation happens in the secrets handler at resolve time.
  ajv.addFormat("secret-ref", { validate: () => true });
  ajv.addVocabulary([...PLUGIN_CONFIG_FORM_KEYWORDS]);
  const validate = ajv.compile(schema);
  const valid = validate(configJson);

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map((err: ErrorObject) => ({
    field: err.instancePath || "/",
    message: err.message ?? "validation failed",
  }));

  return { valid: false, errors };
}

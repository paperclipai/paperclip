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
  // strict: false — plugin manifests use UI-hint keywords (`propertyOrder`,
  // `x-paperclip-actions`, `x-paperclip-showWhen`) that Ajv otherwise rejects.
  // These are read by the form renderer; they have no validation semantics.
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  // ajv-formats v3 default export is a FormatsPlugin object; call it as a plugin.
  const applyFormats = (addFormats as any).default ?? addFormats;
  applyFormats(ajv);
  // UI-hint formats: each marks a field for a specialized form widget but
  // accepts any string at the validator level. Actual identity/UUID checks
  // happen in the plugin worker (e.g. assertCompanyAccess) or in the secrets
  // handler at resolve time.
  ajv.addFormat("secret-ref", { validate: () => true });
  ajv.addFormat("company-id", { validate: () => true });
  ajv.addFormat("project-id", { validate: () => true });
  ajv.addFormat("agent-id", { validate: () => true });
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

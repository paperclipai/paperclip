/**
 * PluginManifestValidator — schema validation for plugin manifest files.
 *
 * Uses the shared Zod schema (`pluginManifestV1Schema`) to validate
 * manifest payloads. Provides both a safe `parse()` variant (returns
 * a result union) and a throwing `parseOrThrow()` for HTTP error
 * propagation at install time.
 *
 * @see PLUGIN_SPEC.md §10 — Plugin Manifest
 * @see packages/shared/src/validators/plugin.ts — Zod schema definition
 */
import { pluginManifestV1Schema } from "@paperclipai/shared";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { PLUGIN_API_VERSION } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

// ---------------------------------------------------------------------------
// Supported manifest API versions
// ---------------------------------------------------------------------------

/**
 * The set of plugin API versions this host can accept.
 * When a new API version is introduced, add it here. Old versions should be
 * retained until the host drops support for them.
 */
const SUPPORTED_VERSIONS = [PLUGIN_API_VERSION] as const;

// ---------------------------------------------------------------------------
// Parse result types
// ---------------------------------------------------------------------------

/**
 * Successful parse result.
 */
export interface ManifestParseSuccess {
  success: true;
  manifest: PaperclipPluginManifestV1;
}

/**
 * Failed parse result. `errors` is a human-readable description of what went
 * wrong; `details` is the raw Zod error list for programmatic inspection.
 */
export interface ManifestParseFailure {
  success: false;
  errors: string;
  details: Array<{ path: (string | number)[]; message: string }>;
}

/** Union of parse outcomes. */
export type ManifestParseResult = ManifestParseSuccess | ManifestParseFailure;

// ---------------------------------------------------------------------------
// PluginManifestValidator interface
// ---------------------------------------------------------------------------

/**
 * Service for parsing and validating plugin manifests.
 *
 * @see PLUGIN_SPEC.md §10 — Plugin Manifest
 */
export interface PluginManifestValidator {
  /**
   * Try to parse `input` as a plugin manifest.
   *
   * Returns a {@link ManifestParseSuccess} when the input passes all
   * validation rules, or a {@link ManifestParseFailure} with human-readable
   * error messages when it does not.
   *
   * This is the "safe" variant — it never throws.
   */
  parse(input: unknown): ManifestParseResult;

  /**
   * Parse `input` as a plugin manifest, throwing a 400 HttpError on failure.
   *
   * Use this at install time when an invalid manifest should surface as an
   * HTTP error to the caller.
   *
   * @throws {HttpError} 400 Bad Request if the manifest is invalid.
   */
  parseOrThrow(input: unknown): PaperclipPluginManifestV1;

  /**
   * Return the list of plugin API versions supported by this host.
   *
   * Callers can use this to present the supported version range to operators
   * or to decide whether a candidate plugin can be installed.
   */
  getSupportedVersions(): readonly number[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link PluginManifestValidator}.
 *
 * Usage:
 * ```ts
 * const validator = pluginManifestValidator();
 *
 * // Safe parse — inspect the result
 * const result = validator.parse(rawManifest);
 * if (!result.success) {
 *   console.error(result.errors);
 *   return;
 * }
 * const manifest = result.manifest;
 *
 * // Throwing parse — use at install time
 * const manifest = validator.parseOrThrow(rawManifest);
 *
 * // Check supported versions
 * const versions = validator.getSupportedVersions(); // [1]
 * ```
 */
export function pluginManifestValidator(): PluginManifestValidator {
  return {
    parse(input: unknown): ManifestParseResult {
      const result = pluginManifestV1Schema.safeParse(input);

      if (result.success) {
        return {
          success: true,
          manifest: result.data as PaperclipPluginManifestV1,
        };
      }

      const details = result.error.errors.map((issue) => ({
        path: issue.path,
        message: issue.message,
      }));

      const errors = details
        .map(({ path, message }) =>
          path.length > 0 ? `${path.join(".")}: ${message}` : message,
        )
        .join("; ");

      return {
        success: false,
        errors,
        details,
      };
    },

    parseOrThrow(input: unknown): PaperclipPluginManifestV1 {
      const result = this.parse(input);

      if (!result.success) {
        throw badRequest(`Invalid plugin manifest: ${result.errors}`, result.details);
      }

      return result.manifest;
    },

    getSupportedVersions(): readonly number[] {
      return SUPPORTED_VERSIONS;
    },
  };
}

/**
 * Structured current-result footer parser for Hermes adapter output.
 *
 * After each Hermes run, the adapter expects a structured footer in the
 * output that proves the exact model that was used.  The footer is parsed
 * and the model identity is authenticated against the exact model catalog
 * (see `model-catalog.ts`).
 *
 * Footer format (appended to the final result block):
 *
 *   ---
 *   model: gemini-3.1-pro-preview
 *   provider: gemini
 *
 * The `model` field is the authentication anchor — it must EXACTLY match
 * a catalog entry.  The `provider` field is informational but also checked
 * if present.
 *
 * Design rules:
 * - Never accept substring matches for the model identity.
 * - Malformed footers (missing model field, empty model, etc.) are rejected.
 * - Stale footers (model field present but empty or whitespace only) are rejected.
 * - The footer must appear at the end of the response, after the `---` separator.
 */

import {
  authenticateModel,
  type ModelCatalogEntry,
  ModelAuthFailure,
  MODEL_CATALOG,
} from "./model-catalog.js";

/** Marker line that starts the footer block. */
const FOOTER_SEPARATOR = "---";

/** Regex for the model line within the footer. */
const MODEL_LINE_REGEX = /^model:\s*(\S.*)$/im;

/** Regex for the provider line within the footer (optional). */
const PROVIDER_LINE_REGEX = /^provider:\s*(\S.*)$/im;

export interface ParsedFooter {
  /** The exact model string from the footer. */
  model: string;
  /** The authenticated catalog entry (null if not in catalog but footer was valid). */
  catalogEntry: ModelCatalogEntry | null;
  /** The provider string from the footer, if present. */
  provider: string | null;
  /** True when the model matched an exact catalog entry. */
  authenticated: boolean;
}

export interface FooterParseResult {
  /** The parsed footer, or null if no valid footer was found. */
  footer: ParsedFooter | null;
  /** True when a footer block was found but was malformed. */
  malformed: boolean;
  /** True when a footer block was found but the model did not match any catalog entry. */
  unauthenticated: boolean;
  /** Error message if parsing failed. */
  error: string | null;
}

/**
 * Extract and validate the structured current-result footer from Hermes output.
 *
 * The footer is the last `---`-delimited block at the end of the output.
 * Returns a structured result with parse status and authentication outcome.
 *
 * @param output The full Hermes stdout/stderr output.
 * @returns ParsedFooter result with authentication status.
 */
export function parseCurrentResultFooter(output: string): FooterParseResult {
  if (typeof output !== "string" || output.length === 0) {
    return { footer: null, malformed: false, unauthenticated: false, error: null };
  }

  // Split on the footer separator.  The footer is the last block after
  // the final "---" line.  We look for the last occurrence of the separator
  // followed by footer content.
  const segments = output.split(/\n---\s*\n/);

  if (segments.length < 2) {
    // Check for "---" at the very end (trailing separator with nothing after)
    if (/---\s*$/.test(output)) {
      return {
        footer: null,
        malformed: true,
        unauthenticated: false,
        error: "Footer separator found but no content after it (stale or malformed footer).",
      };
    }
    return { footer: null, malformed: false, unauthenticated: false, error: null };
  }

  // The footer is the content after the last separator
  const footerText = segments[segments.length - 1].trim();

  if (footerText.length === 0) {
    return {
      footer: null,
      malformed: true,
      unauthenticated: false,
      error: "Footer block is empty (malformed footer).",
    };
  }

  // Parse model line (required)
  const modelMatch = footerText.match(MODEL_LINE_REGEX);
  const modelValue = modelMatch?.[1]?.trim() ?? "";

  if (modelValue === "") {
    return {
      footer: null,
      malformed: true,
      unauthenticated: false,
      error: "Footer model field is missing or empty (malformed/stale footer).",
    };
  }

  // Parse provider line (optional)
  const providerMatch = footerText.match(PROVIDER_LINE_REGEX);
  const providerValue = providerMatch?.[1]?.trim() ?? null;

  // Authenticate the model against the exact catalog
  const catalogEntry = authenticateModel(modelValue);
  const authenticated = catalogEntry !== null;

  if (!authenticated) {
    return {
      footer: {
        model: modelValue,
        catalogEntry: null,
        provider: providerValue,
        authenticated: false,
      },
      malformed: false,
      unauthenticated: true,
      error: `Footer model "${modelValue}" is not an exact catalog entry.`,
    };
  }

  // If provider is present in the footer, verify it matches the catalog entry
  if (providerValue && providerValue !== catalogEntry!.provider) {
    return {
      footer: {
        model: modelValue,
        catalogEntry,
        provider: providerValue,
        authenticated: false,
      },
      malformed: false,
      unauthenticated: true,
      error: `Footer provider "${providerValue}" does not match catalog provider "${catalogEntry!.provider}".`,
    };
  }

  return {
    footer: {
      model: modelValue,
      catalogEntry,
      provider: providerValue,
      authenticated: true,
    },
    malformed: false,
    unauthenticated: false,
    error: null,
  };
}

/**
 * Extract only the model identity from the footer, without authentication.
 *
 * This is useful when you need to read what model the footer claims was used,
 * before deciding whether to authenticate it.
 *
 * @param output The full Hermes stdout/stderr output.
 * @returns The raw model string from the footer, or null if no footer found.
 */
export function extractFooterModel(output: string): string | null {
  const result = parseCurrentResultFooter(output);
  return result.footer?.model ?? null;
}

/**
 * Full footer authentication: parse the footer and require an exact catalog match.
 *
 * @param output The full Hermes stdout/stderr output.
 * @returns The authenticated model catalog entry.
 * @throws {ModelAuthFailure} when no footer is present, the footer is malformed,
 *   or the model does not exactly match a catalog entry.
 */
export function requireFooterModel(output: string): ModelCatalogEntry {
  const result = parseCurrentResultFooter(output);

  if (result.malformed) {
    throw new ModelAuthFailure(
      result.error ?? "Malformed footer — cannot authenticate model.",
    );
  }

  if (result.footer === null) {
    throw new ModelAuthFailure(
      "No current-result footer found in output — model cannot be authenticated.",
    );
  }

  if (!result.footer.authenticated) {
    throw new ModelAuthFailure(result.footer.model);
  }

  return result.footer.catalogEntry!;
}

/**
 * Expose the catalog and authentication primitives for inspection/testing
 * and for callers (e.g. execute.ts) that need both footer parsing and
 * direct catalog access.
 */
export { MODEL_CATALOG, authenticateModel, ModelAuthFailure };
export type { ModelCatalogEntry } from "./model-catalog.js";

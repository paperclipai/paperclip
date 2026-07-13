import type { ProviderShape } from "../types.js";
import { slackShape } from "./slack.js";
import { microsoftShape } from "./microsoft.js";

/**
 * Registry of named shape modules referenced by `shape: <name>` in provider
 * YAML files. Resolved statically at startup to keep the bootstrap path free
 * of dynamic ESM imports (which behave differently between dev/`tsx` and
 * compiled `.js`).
 *
 * To add a new shape: write the module, import it here, and add an entry.
 */
export const KNOWN_SHAPES: Readonly<Record<string, ProviderShape>> = {
  slack: slackShape,
  microsoft: microsoftShape,
};

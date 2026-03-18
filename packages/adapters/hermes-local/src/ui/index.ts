/**
 * UI module exports — used by Paperclip's dashboard for run viewing
 * and agent configuration forms.
 */
import { parseHermesStdoutLine as parseLine } from "./parse-stdout.js";

// Re-export for consumers
export { buildHermesConfig } from "./build-config.js";

// Wrap parser to match expected signature
export const parseHermesStdoutLine = parseLine;

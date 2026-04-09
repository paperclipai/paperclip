/**
 * Dynamic UI parser loading for external adapters.
 *
 * When the Paperclip UI encounters an adapter type that doesn't have a
 * built-in parser (e.g., an external adapter loaded via the plugin system),
 * it fetches the parser JS from `/api/adapters/:type/ui-parser.js` and
 * evaluates it to create a `parseStdoutLine` function.
 *
 * The parser module must export:
 *   - `parseStdoutLine(line: string, ts: string): TranscriptEntry[]`
 *   - optionally `createStdoutParser(): { parseLine, reset }` for stateful parsers
 *
 * This is the bridge between the server-side plugin system and the client-side
 * UI rendering. Adapter developers ship a `dist/ui-parser.js` with zero
 * runtime dependencies, and Paperclip's UI loads it on demand.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { StatefulStdoutParser, StdoutLineParser, StdoutParserFactory } from "./types";

interface DynamicParserModule {
  parseStdoutLine: StdoutLineParser;
  createStdoutParser?: StdoutParserFactory;
}

// Cache of dynamically loaded parsers by adapter type.
// Once loaded, the parser is reused for all runs of that adapter type.
const dynamicParserCache = new Map<string, DynamicParserModule>();

// Track which types we've already attempted to load (to avoid repeat 404s).
const failedLoads = new Set<string>();

/**
 * Dynamically load a UI parser for an adapter type from the server API.
 *
 * Fetches `/api/adapters/:type/ui-parser.js`, evaluates the module source
 * in a scoped context, and extracts the `parseStdoutLine` export.
 *
 * @returns A StdoutLineParser function, or null if unavailable.
 */
export async function loadDynamicParser(adapterType: string): Promise<DynamicParserModule | null> {
  // Return cached parser if already loaded
  const cached = dynamicParserCache.get(adapterType);
  if (cached) return cached;

  // Don't retry types that previously 404'd
  if (failedLoads.has(adapterType)) return null;

  try {
    const response = await fetch(`/api/adapters/${encodeURIComponent(adapterType)}/ui-parser.js`);
    if (!response.ok) {
      failedLoads.add(adapterType);
      return null;
    }

    const source = await response.text();

    // Evaluate the module source using URL.createObjectURL + dynamic import().
    // This properly supports ESM modules with `export` statements.
    // (new Function("exports", source) would fail with SyntaxError on `export` keywords.)
    const blob = new Blob([source], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    let parserModule: DynamicParserModule;

    try {
      const mod = await import(/* @vite-ignore */ blobUrl);

      // Prefer the factory function (stateful parser) if available,
      // fall back to the static parseStdoutLine function.
      if (typeof mod.createStdoutParser === "function") {
        const createStdoutParser = mod.createStdoutParser as StdoutParserFactory;
        parserModule = {
          createStdoutParser,
          // Fallback for callers that only know about parseStdoutLine.
          parseStdoutLine:
            typeof mod.parseStdoutLine === "function"
              ? (mod.parseStdoutLine as StdoutLineParser)
              : ((line: string, ts: string) => {
                  const parser = createStdoutParser() as StatefulStdoutParser;
                  const entries = parser.parseLine(line, ts);
                  parser.reset();
                  return entries;
                }),
        };
      } else if (typeof mod.parseStdoutLine === "function") {
        parserModule = {
          parseStdoutLine: mod.parseStdoutLine as StdoutLineParser,
        };
      } else {
        console.warn(`[adapter-ui-loader] Module for "${adapterType}" exports neither parseStdoutLine nor createStdoutParser`);
        failedLoads.add(adapterType);
        return null;
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    // Cache for reuse
    dynamicParserCache.set(adapterType, parserModule);
    console.info(`[adapter-ui-loader] Loaded dynamic UI parser for "${adapterType}"`);
    return parserModule;
  } catch (err) {
    console.warn(`[adapter-ui-loader] Failed to load UI parser for "${adapterType}":`, err);
    failedLoads.add(adapterType);
    return null;
  }
}

/**
 * Invalidate a cached dynamic parser, removing it from both the parser cache
 * and the failed-loads set so that the next load attempt will try again.
 */
export function invalidateDynamicParser(adapterType: string): boolean {
  const wasCached = dynamicParserCache.has(adapterType);
  dynamicParserCache.delete(adapterType);
  failedLoads.delete(adapterType);
  if (wasCached) {
    console.info(`[adapter-ui-loader] Invalidated dynamic UI parser for "${adapterType}"`);
  }
  return wasCached;
}

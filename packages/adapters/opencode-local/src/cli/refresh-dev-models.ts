#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  refreshDevModels,
  RefreshDevModelsError,
  type RefreshDevModelsOptions,
} from "../server/refresh-dev-models.js";

/**
 * CLI entry for the LocalLLM model-config freshness generator.
 *
 * Polls the live Ollama server and rewrites ONLY `provider.dev.models` in the
 * source opencode config, fail-safe throughout. Intended to be run on a short
 * schedule (Paperclip routine or cron) so the configured model list never
 * drifts from what the server actually serves.
 *
 * Usage:
 *   refresh-dev-models [--config PATH] [--ollama-url URL] [--provider-key KEY]
 *                      [--timeout-ms N] [--dry-run] [--quiet]
 *
 * Exit codes: 0 = success (config fresh / unchanged / written),
 *             1 = fail-safe no-op on any error (config left intact).
 */

interface ParsedArgs {
  options: RefreshDevModelsOptions;
  quiet: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const options: RefreshDevModelsOptions = {};
  let quiet = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new RefreshDevModelsError(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--config":
        options.configPath = next();
        break;
      case "--ollama-url":
        options.ollamaUrl = next();
        break;
      case "--provider-key":
        options.providerKey = next();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number.parseInt(next(), 10) || DEFAULT_FETCH_TIMEOUT_MS;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      default:
        throw new RefreshDevModelsError(`unknown argument: ${arg}`);
    }
  }
  return { options, quiet, help };
}

const HELP = `refresh-dev-models — keep provider.dev.models fresh against live Ollama

Usage:
  refresh-dev-models [--config PATH] [--ollama-url URL] [--provider-key KEY]
                     [--timeout-ms N] [--dry-run] [--quiet]

Exit codes: 0 = success, 1 = fail-safe no-op on error (config left intact).`;

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[refresh-dev-models] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  try {
    const result = await refreshDevModels({
      ...parsed.options,
      logger: parsed.quiet ? () => {} : undefined,
    });
    if (result.dryRun) process.stdout.write(result.payload);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[refresh-dev-models] FAIL-SAFE: ${message}\n`);
    return 1;
  }
}

// Direct-exec guard: only run when invoked as a script, not when imported.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[refresh-dev-models] FATAL: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    },
  );
}

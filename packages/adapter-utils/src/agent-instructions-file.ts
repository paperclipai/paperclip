import fs from "node:fs/promises";
import path from "node:path";

import type { AdapterInstructionsReadFailure } from "./types.js";

export type { AdapterInstructionsReadFailure } from "./types.js";

export interface ReadAdapterInstructionsFileOptions {
  /** Raw `adapterConfig.instructionsFilePath` value (already trimmed or not). */
  instructionsFilePath: unknown;
  /**
   * When set, a relative configured path is resolved against this directory.
   * Adapters that historically used the configured path as-is should omit it.
   */
  cwd?: string | null;
  /** Adapter log sink; the read failure is logged exactly once here. */
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> | void;
  /** Stream used for the warning line. Adapters differ; default keeps stdout. */
  logStream?: "stdout" | "stderr";
  /** Log line prefix, e.g. "[paperclip]" (default) or "[hermes]". */
  logPrefix?: string;
}

export interface AdapterInstructionsFile {
  /** Configured path after trimming; empty when the agent has no instructions file. */
  configuredPath: string;
  /** Path the adapter actually attempted to read; empty when nothing is configured. */
  resolvedPath: string;
  /** `dirname(resolvedPath)` with a trailing separator, or "" when nothing is configured. */
  directory: string;
  /** File contents, or null when nothing is configured or the read failed. */
  contents: string | null;
  /**
   * Set only when a configured instructions file could not be read. Adapters must
   * propagate this onto their `AdapterExecutionResult` so the control plane can
   * surface it on the agent record instead of degrading silently forever.
   */
  failure: AdapterInstructionsReadFailure | null;
}

/**
 * Read an agent's configured instructions file.
 *
 * Every local adapter used to inline this read plus a bare `catch` that logged one
 * stdout line and fell back to the generic prompt template, so a mistyped or moved
 * instructions path degraded the agent silently and indefinitely. This helper keeps
 * the same non-fatal behaviour for a single miss (a transient FS blip must not take
 * an agent down) but returns a structured `failure` the adapter is expected to report
 * back to the server on the execution result.
 */
export async function readAdapterInstructionsFile(
  options: ReadAdapterInstructionsFileOptions,
): Promise<AdapterInstructionsFile> {
  const configuredPath =
    typeof options.instructionsFilePath === "string" ? options.instructionsFilePath.trim() : "";
  if (!configuredPath) {
    return { configuredPath: "", resolvedPath: "", directory: "", contents: null, failure: null };
  }

  const resolvedPath = options.cwd ? path.resolve(options.cwd, configuredPath) : configuredPath;
  const directory = `${path.dirname(resolvedPath)}/`;

  try {
    const contents = await fs.readFile(resolvedPath, "utf8");
    return { configuredPath, resolvedPath, directory, contents, failure: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const code =
      typeof (err as NodeJS.ErrnoException | undefined)?.code === "string"
        ? (err as NodeJS.ErrnoException).code ?? null
        : null;
    const prefix = options.logPrefix ?? "[paperclip]";
    await options.onLog?.(
      options.logStream ?? "stdout",
      `${prefix} Warning: could not read agent instructions file "${resolvedPath}": ${reason}\n`,
    );
    return {
      configuredPath,
      resolvedPath,
      directory,
      contents: null,
      failure: { path: resolvedPath, reason, code },
    };
  }
}

/**
 * Command note describing an unreadable instructions file, so the run's invocation
 * metadata says why no instructions were injected.
 */
export function instructionsReadFailureCommandNote(
  failure: AdapterInstructionsReadFailure,
): string {
  return `Configured instructionsFilePath ${failure.path}, but file could not be read (${failure.reason}); continuing without injected instructions.`;
}

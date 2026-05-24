/**
 * Phase 3.5 Step 2 -- worker exit-hook artifact uploader.
 *
 * Pure function: scans `<agentHomeDir>/artifacts/out/` for completed
 * artifact files and pushes each one to agent-fs via the supplied
 * `ArtifactUploadClient`. Designed to be called from the worker exit
 * hook in heartbeat.ts immediately after `ingestGuildLearnings` succeeds
 * and before `cleanupGuildRunSandbox`.
 *
 * Error policy:
 *   - ENOENT on the artifacts/out dir: silently no-op (skipped.reason =
 *     'no-artifacts-dir'). Workers that produced no output are common
 *     (e.g. research stage only writes JSON; edit stage also writes .mp4).
 *   - Per-file read or upload failure: push to `failed[]` with the
 *     error message and continue. Never throw out of this function.
 *   - Hidden files (leading '.') and '.partial' suffix: skipped silently.
 *   - Non-file directory entries (subdirectories): skipped silently.
 *
 * See docs/superpowers/plans/2026-05-23-video-guild-implementation.md
 * Phase 3.5 Step 2.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { ArtifactUploadClient } from "./artifacts-client.js";

export interface UploadWorkerArtifactsInput {
  /** Absolute path to the agent's home directory (from
   * `resolveDefaultAgentWorkspaceDir`). Artifacts live at
   * `<agentHomeDir>/artifacts/out/<filename>`. */
  agentHomeDir: string;
  /** Video ad request id, e.g. `campaign-42`. */
  requestId: string;
  /** Video pipeline stage, e.g. `research`. */
  stage: string;
  /** Client used to push each file to agent-fs. */
  uploadClient: ArtifactUploadClient;
  /** Minimal logger surface. Only `warn` is used (per warn-log-continue
   * policy). Tests inject a no-op or spy; production passes `logger`. */
  logger: { warn: (...args: unknown[]) => void };
  /**
   * Maximum file size in bytes before the file is skipped (pushed to
   * `failed[]` with reason `"file-too-large"`) instead of being read
   * into memory and uploaded.
   *
   * Rationale: each file is buffered in the Node.js heap before the
   * upload. 200 MB is well under agent-fs's 500 MB binary cap and leaves
   * headroom, while bounding the control-plane process memory on
   * worst-case video artifact sizes. Override in tests via this field.
   *
   * Defaults to 200 * 1024 * 1024 (200 MB) when omitted.
   */
  maxFileBytes?: number;
}

export interface UploadWorkerArtifactsResult {
  /** Filenames (basename only) that were successfully uploaded. */
  uploaded: string[];
  /** Files that failed to read or upload. Each entry carries the
   * filename and a human-readable reason. */
  failed: Array<{ filename: string; reason: string }>;
  /** Non-null when the artifacts/out directory did not exist (ENOENT).
   * Normal for workers that produced no output files. */
  skipped: { reason: "no-artifacts-dir" } | null;
  /**
   * True when all uploaded files were successfully removed from
   * `artifacts/out/` after upload (bounds disk growth on long-lived
   * agent homes). False when cleanup was skipped (any file failed) or
   * when cleanup itself encountered an error (warn-and-continue).
   */
  artifactsOutCleaned: boolean;
}

/** Default file size cap: 200 MB. */
const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * Scans `<agentHomeDir>/artifacts/out/` and uploads each eligible file
 * to agent-fs. Returns a structured result; never throws.
 */
export async function uploadWorkerArtifacts(
  input: UploadWorkerArtifactsInput,
): Promise<UploadWorkerArtifactsResult> {
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const outDir = path.join(input.agentHomeDir, "artifacts", "out");

  let entries: import("node:fs").Dirent<string>[];
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true, encoding: "utf-8" }) as import("node:fs").Dirent<string>[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Expected for workers that produced no artifacts.
      return { uploaded: [], failed: [], skipped: { reason: "no-artifacts-dir" }, artifactsOutCleaned: false };
    }
    // Unexpected readdir failure (permissions, etc.) -- treat as warn.
    input.logger.warn(
      { err, agentHomeDir: input.agentHomeDir, outDir },
      "upload-worker-artifacts: readdir failed unexpectedly",
    );
    return { uploaded: [], failed: [], skipped: null, artifactsOutCleaned: false };
  }

  const uploaded: string[] = [];
  const failed: Array<{ filename: string; reason: string }> = [];

  for (const entry of entries) {
    // Skip non-file entries (subdirectories, symlinks, etc.).
    if (!entry.isFile()) continue;
    const filename = entry.name;
    // Skip hidden dotfiles and incomplete .partial files.
    if (filename.startsWith(".") || filename.endsWith(".partial")) continue;

    const filePath = path.join(outDir, filename);

    // File-size guard: stat before read to avoid buffering huge files
    // into the control-plane heap. 200 MB default is well under agent-fs's
    // 500 MB binary cap and leaves headroom while bounding heap pressure.
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size > maxFileBytes) {
        failed.push({
          filename,
          reason: `file-too-large: ${stat.size} bytes exceeds limit of ${maxFileBytes} bytes`,
        });
        continue;
      }
    } catch (statErr) {
      failed.push({
        filename,
        reason: statErr instanceof Error ? statErr.message : String(statErr),
      });
      continue;
    }

    let body: Buffer;
    try {
      body = await fsp.readFile(filePath);
    } catch (readErr) {
      failed.push({
        filename,
        reason: readErr instanceof Error ? readErr.message : String(readErr),
      });
      continue;
    }

    try {
      await input.uploadClient.uploadArtifact(
        input.requestId,
        input.stage,
        filename,
        body,
      );
      uploaded.push(filename);
    } catch (uploadErr) {
      failed.push({
        filename,
        reason: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
      });
    }
  }

  // Post-upload cleanup: remove successfully uploaded files from artifacts/out/
  // to bound disk growth on long-lived agent homes. Only runs when at least
  // one file was uploaded AND no files failed (leave dir intact for operator
  // inspection / retry when any upload failed).
  let artifactsOutCleaned = false;
  if (uploaded.length > 0 && failed.length === 0) {
    try {
      for (const filename of uploaded) {
        const filePath = path.join(outDir, filename);
        // Use fsp.rm with force:true -- fsp.unlink on a dir is EISDIR on
        // Linux, but these are all confirmed files from the loop above.
        // force:true is defensive against a race where the file disappears
        // between upload and cleanup.
        await fsp.rm(filePath, { force: true });
      }
      artifactsOutCleaned = true;
    } catch (cleanupErr) {
      // Warn and continue -- cleanup failure never blocks the run result.
      input.logger.warn(
        { err: cleanupErr, agentHomeDir: input.agentHomeDir, outDir },
        "upload-worker-artifacts: cleanup of artifacts/out/ failed; files left on disk",
      );
    }
  }

  return { uploaded, failed, skipped: null, artifactsOutCleaned };
}

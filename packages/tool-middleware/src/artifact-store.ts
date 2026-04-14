/**
 * Artifact store — content-addressed storage for full tool stdout/stderr.
 *
 * Files are stored at `{artifactsDir}/{hash}` (SHA-256 hex of content).
 * Artifacts are cleaned up per-session by the session cleanup logic.
 * A secret redactor is applied before writing.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./secret-redactor.js";
import type { ArtifactRef } from "./types.js";

export const ARTIFACT_URI_PREFIX = "artifact://";

/** Compute SHA-256 hash of content. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Store content in the artifact directory, returning a ref. */
export async function storeArtifact(content: string, artifactsDir: string): Promise<ArtifactRef> {
  const redacted = redactSecrets(content);
  const hash = sha256(redacted);
  const uri = `${ARTIFACT_URI_PREFIX}${hash}`;
  const bytes = Buffer.byteLength(redacted, "utf8");
  const lines = redacted.split("\n").length;

  await fs.mkdir(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, hash);
  // Write only if not already stored (content-addressed — same content → same hash).
  try {
    await fs.access(filePath);
    // File already exists — skip write (idempotent)
  } catch {
    await fs.writeFile(filePath, redacted, "utf8");
  }

  return { hash, uri, bytes, lines };
}

/** Read a stored artifact by its hash. Returns null if not found. */
export async function readArtifact(hash: string, artifactsDir: string): Promise<string | null> {
  const filePath = path.join(artifactsDir, hash);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Delete all artifacts older than the given age in seconds. */
export async function pruneArtifacts(artifactsDir: string, maxAgeSeconds: number): Promise<number> {
  let removed = 0;
  const now = Date.now();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(artifactsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Skip cache subdirectory
    if (entry.name === "cache") continue;
    const filePath = path.join(artifactsDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      const ageSeconds = (now - stat.mtimeMs) / 1000;
      if (ageSeconds > maxAgeSeconds) {
        await fs.unlink(filePath);
        removed++;
      }
    } catch {
      // Ignore errors on individual files
    }
  }
  return removed;
}

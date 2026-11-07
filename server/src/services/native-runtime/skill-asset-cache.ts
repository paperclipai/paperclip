import { withRuntimeAssetUse } from "./runtime-asset-retention.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { NativeRuntimeAssetReference } from "../../vendor/paperclip-runner/index.js";
import { verifyFileManifest, type FileManifestEntry } from "../file-manifest-cache.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

type Cached = { manifest: FileManifestEntry[]; bundle: NativeRuntimeAssetReference };
const entries = new Map<string, Cached>();
let fileCount = 0;
const MAX_FILES = 32_000;
const MAX_ENTRIES = 128;
const cacheKey = (source: string) => `${resolvePaperclipInstanceRoot()}:${source}`;

/** The caller supplies freshly authorized runtime entries on every turn. This
 * cache retains no authority or file bodies, and verifies source and destination
 * identities before reusing the content-addressed native asset reference. */
export async function cachedSkillAsset(source: string): Promise<NativeRuntimeAssetReference | null> {
  const cached = entries.get(cacheKey(source));
  if (!cached || !await verifyFileManifest(source, cached.manifest)) return null;
  return withRuntimeAssetUse(cached.bundle.digest, async () => {
    const manifestPath = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets", "manifests", `${cached.bundle.digest}.json`);
    const manifest = await fs.readFile(manifestPath).catch(() => null);
    if (!manifest || !(await fs.lstat(cached.bundle.rootPath).catch(() => null))?.isDirectory()) return null;
    if (createHash("sha256").update(manifest).digest("hex") !== cached.bundle.manifestDigest
      || !await verifyFileManifest(cached.bundle.rootPath, cached.manifest)) {
      return null;
    }
    return cached.bundle;
  });
}

export function rememberSkillAsset(source: string, manifest: FileManifestEntry[], bundle: NativeRuntimeAssetReference) {
  if (manifest.length > MAX_FILES) return;
  const key = cacheKey(source);
  const previous = entries.get(key);
  if (previous) { fileCount -= previous.manifest.length; entries.delete(key); }
  while (entries.size && (fileCount + manifest.length > MAX_FILES || entries.size >= MAX_ENTRIES)) {
    const first = entries.keys().next().value!;
    fileCount -= entries.get(first)!.manifest.length;
    entries.delete(first);
  }
  entries.set(key, { manifest, bundle });
  fileCount += manifest.length;
}

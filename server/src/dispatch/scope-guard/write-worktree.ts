import fs from "node:fs";
import path from "node:path";
import { type ScopeGuardManifest, serializeManifest } from "./manifest.js";

const SCOPE_GUARD_DIR = ".paperclip";
const SCOPE_GUARD_FILE = "scope-guard.json";

export type WriteWorktreeManifestResult =
  | { ok: true; manifestPath: string }
  | { ok: false; error: string; gap: string };

export function writeWorktreeManifest(
  worktreeRoot: string,
  manifest: ScopeGuardManifest,
): WriteWorktreeManifestResult {
  const dir = path.resolve(worktreeRoot, SCOPE_GUARD_DIR);
  const manifestPath = path.resolve(dir, SCOPE_GUARD_FILE);

  try {
    fs.mkdirSync(dir, { recursive: true });
    const content = serializeManifest(manifest);
    fs.writeFileSync(manifestPath, content, { mode: 0o444 });
    return { ok: true, manifestPath };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Dev hosts where dispatch runs as agent uid cannot set mode 444 on the file in
    // a way that root cannot override. Document the gap here; SG-2 will harden this
    // with root-owned files and /etc/gitconfig core.hooksPath wiring.
    const gap =
      "SG-2 gap: on dev hosts the manifest is agent-uid-writable. " +
      "Root ownership + chmod 444 enforcement is deferred to SG-2 hardening.";
    return { ok: false, error, gap };
  }
}

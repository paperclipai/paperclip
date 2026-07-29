import { readFileSync } from "node:fs";
import path from "node:path";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import type { SandboxManagedRuntimeAssetProvision } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

// Codex-specific inbound auth-merge assets. These live alongside the Codex
// adapter server code; the two script files (`codex-auth-merge-extract.sh` and
// `codex-auth-merge-decision.cjs`) are read from this directory at runtime and
// staged into the sandbox. The sandbox runtime *core*
// (`sandbox-managed-runtime.ts`) is intentionally free of any Codex knowledge —
// the adapter supplies this contribution through the generic `provision` seam.

export const CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME = "codex-auth-merge-extract.sh";
export const CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME = "codex-auth-merge-decision.cjs";

const CODEX_AUTH_MERGE_EXTRACT_SCRIPT_BYTES = readFileSync(
  new URL(`./${CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME}`, import.meta.url),
);
const CODEX_AUTH_MERGE_DECISION_SCRIPT_BYTES = readFileSync(
  new URL(`./${CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME}`, import.meta.url),
);

/**
 * Builds the inbound (host→sandbox) provisioning contribution for the Codex
 * managed-home asset as **files + an ordered post-upload merge command**: the two
 * merge scripts ride the sync operation's `files` (staged into the runtime root
 * alongside the uploaded home tar via native `uploadFiles`), and the merge-extract
 * script runs as the operation's ordered **post-upload command** instead of a
 * plain `tar -xf`, so a sandbox that already carries a Codex `auth.json` keeps
 * whichever credential is newer (newer-`auth.json`-wins, same-identity, atomic
 * `0600` install — all inside the opaque script, unchanged).
 *
 * The command string handed to the provider is opaque and fully shell-quoted from
 * already-confined paths (Security Conditions C1/C3): it invokes only the staged
 * script by path — no `auth.json` bytes, token fields, or workspace content are
 * interpolated into the shell (C5). This is behaviour-identical to the extraction
 * the sandbox core previously drove through the custom-provision tar path.
 */
export function buildCodexAuthInboundProvision(): SandboxManagedRuntimeAssetProvision {
  return {
    stageFiles: [
      { name: CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME, contents: CODEX_AUTH_MERGE_EXTRACT_SCRIPT_BYTES },
      { name: CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME, contents: CODEX_AUTH_MERGE_DECISION_SCRIPT_BYTES },
    ],
    postUploadCommand: ({ assetTarPath, assetDir, runtimeRootDir }) =>
      `sh ${shellQuote(path.posix.join(runtimeRootDir, CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME))} ` +
      `${shellQuote(assetDir)} ${shellQuote(assetTarPath)}`,
  };
}

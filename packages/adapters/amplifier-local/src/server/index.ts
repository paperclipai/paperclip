/**
 * Server-side public exports for @paperclipai/adapter-amplifier-local.
 *
 * Imported by paperclip's server/src/adapters/registry.ts.
 */

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export {
  asAmplifierErrorView,
  describeAmplifierError,
  isAmplifierApprovalUnconfiguredError,
  isAmplifierBundleLoadFailedError,
  isAmplifierProtocolMismatchError,
  isAmplifierUnknownSessionError,
} from "./parse.js";
export type { AmplifierErrorView } from "./parse.js";
export {
  resolveAmplifierLocalManagedDir,
  resolveHostConfigPath,
  resolveSkillsDir,
  writeHostConfigAtomic,
} from "./amplifier-host-config.js";
export type { AmplifierAgentHostConfig } from "./amplifier-host-config.js";

// ---------------------------------------------------------------------------
// sessionCodec
// ---------------------------------------------------------------------------

/**
 * Paperclip persists `sessionParams` opaquely per task. The codec validates
 * the shape and extracts a human-readable display id.
 *
 * Fields the adapter writes (see execute.ts buildResult):
 *   sessionId    — the amplifier-agent session id (REQUIRED)
 *   cwd          — effective execution cwd at time of session creation
 *   workspaceId  — paperclip workspace id (when an active workspace)
 *   repoUrl      — workspace repo URL (when applicable)
 *   repoRef      — workspace repo ref (when applicable)
 *
 * Deserialize tolerates both camelCase and snake_case aliases (defensive
 * forward-compat with engine versions that might emit snake_case in JSON
 * envelope metadata).
 */
function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    const workspaceId =
      readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
    const repoUrl =
      readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
    const repoRef =
      readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd);
    const workspaceId = readNonEmptyString(params.workspaceId);
    const repoUrl = readNonEmptyString(params.repoUrl);
    const repoRef = readNonEmptyString(params.repoRef);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoRef ? { repoRef } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString((params as Record<string, unknown>).session_id)
    );
  },
};

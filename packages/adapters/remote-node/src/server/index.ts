export { execute, remoteRunWaiters, remoteCompletionEmitter, type RemoteRunWaiter } from "./execute.js";
export { testEnvironment } from "./test.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for remote_node: delegates to the same sessionId/cwd pattern
 * used by claude_local since the runner typically executes claude_local on the node.
 * The remote runner reports back sessionParams and they pass through unchanged.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd);
    const workspaceId = readNonEmptyString(record.workspaceId);
    const repoUrl = readNonEmptyString(record.repoUrl);
    const repoRef = readNonEmptyString(record.repoRef);
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
    return readNonEmptyString(params.sessionId);
  },
};

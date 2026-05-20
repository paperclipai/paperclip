import path from "node:path";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

/**
 * Session validation result indicating whether a session can be resumed.
 */
export interface SessionValidation {
  /** Session ID to resume, or null for a new session */
  sessionId: string | null;
  /** Whether the session can be resumed */
  canResume: boolean;
  /** Reason why session cannot be resumed (if applicable) */
  reason?: string;
}

/**
 * Parameters for validating session resumption.
 */
export interface ValidateSessionParams {
  /** Runtime session parameters from previous execution */
  runtime: AdapterExecutionContext["runtime"];
  /** Current working directory */
  cwd: string;
  /** Current prompt bundle key */
  promptBundleKey: string;
}

/**
 * Validates whether a Bob Shell session can be resumed.
 * 
 * A session can be resumed only if:
 * 1. A session ID exists from the previous run
 * 2. The prompt bundle key matches (or is not set)
 * 3. The working directory matches (or is not set)
 * 
 * @param params - Validation parameters
 * @returns Session validation result
 * 
 * @example
 * ```typescript
 * const validation = validateSession({
 *   runtime: { sessionId: "session-123", sessionParams: {...} },
 *   cwd: "/workspace",
 *   promptBundleKey: "bundle-abc"
 * });
 * 
 * if (validation.canResume) {
 *   console.log(`Resuming session ${validation.sessionId}`);
 * } else {
 *   console.log(`Starting new session: ${validation.reason}`);
 * }
 * ```
 */
export function validateSession(params: ValidateSessionParams): SessionValidation {
  const { runtime, cwd, promptBundleKey } = params;

  // Extract session information from runtime
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");

  // No session to resume
  if (!runtimeSessionId) {
    return {
      sessionId: null,
      canResume: false,
      reason: "No previous session",
    };
  }

  // Check prompt bundle compatibility
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundleKey;

  if (!hasMatchingPromptBundle) {
    return {
      sessionId: null,
      canResume: false,
      reason: `Prompt bundle changed from "${runtimePromptBundleKey}" to "${promptBundleKey}"`,
    };
  }

  // Check working directory compatibility
  const hasMatchingCwd =
    runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd);

  if (!hasMatchingCwd) {
    return {
      sessionId: null,
      canResume: false,
      reason: `Working directory changed from "${runtimeSessionCwd}" to "${cwd}"`,
    };
  }

  // Session can be resumed
  return {
    sessionId: runtimeSessionId,
    canResume: true,
  };
}

/**
 * Builds session parameters for storing in runtime state.
 * 
 * @param sessionId - Session ID to store
 * @param cwd - Working directory
 * @param promptBundleKey - Prompt bundle key
 * @param workspaceId - Optional workspace ID
 * @param workspaceRepoUrl - Optional repository URL
 * @param workspaceRepoRef - Optional repository ref
 * @returns Session parameters object
 */
export function buildSessionParams(
  sessionId: string,
  cwd: string,
  promptBundleKey: string,
  workspaceId?: string | null,
  workspaceRepoUrl?: string | null,
  workspaceRepoRef?: string | null,
): Record<string, unknown> {
  return {
    sessionId,
    cwd,
    promptBundleKey,
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
    ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
  };
}

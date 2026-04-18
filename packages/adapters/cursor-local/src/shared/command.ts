import { ensureCommandResolvable } from "@paperclipai/adapter-utils/server-utils";

/**
 * Resolve which Cursor CLI binary is available on PATH.
 *
 * Cursor ships as `cursor-agent` on most platforms. Some older installs expose
 * only `agent`. We probe in preference order and return the first resolvable
 * name so that neither spelling silently disappears from the Paperclip adapter
 * list.
 *
 * If neither candidate resolves we return `"cursor-agent"` and let the
 * downstream `ensureCommandResolvable` call produce the real error with full
 * context (PATH, cwd, remediation hint).
 */
export async function resolveCursorDefaultCommand(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  for (const candidate of ["cursor-agent", "agent"]) {
    try {
      await ensureCommandResolvable(candidate, cwd, env);
      return candidate;
    } catch {
      // not on PATH — try next
    }
  }
  return "cursor-agent";
}

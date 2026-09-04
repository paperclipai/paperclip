/**
 * Environment handed to every Devin CLI child process.
 *
 * An inherited ACP_BACKEND (present whenever Paperclip or the operator's
 * shell runs inside a Devin Desktop / ACP session) makes every CLI call
 * report "Not logged in" — the CLI routes auth at the parent session's ACP
 * backend instead of the host credential store. Verified live 2026-09-03
 * (CLI 3000.6.12, host env ACP_BACKEND=windsurf from Devin Desktop):
 * `devin models list` failed with "Not logged in" until the variable was
 * unset, then returned the full catalog with the same credentials.
 *
 * Two layers enforce this: this helper covers the direct `execFile` probes
 * (model discovery, environment test); the spawned run path is covered by
 * the post-merge strip in `runChildProcess` (`server-utils.ts`), which wins
 * over everything, including adapter config.
 */
export function devinCliEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === 'ACP_BACKEND') continue;
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
